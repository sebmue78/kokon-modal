import Foundation
import Metal

/// **The target's attention cut by heads** between the GPU, the CPU and (optionally) the Neural Engine, beside one
/// another as the products are cut by rows (`Coexecution.swift`); the units would otherwise idle through ~40 % of a step.
///
/// Measured at 1024² (M2 Pro, `time-dit`, 2026-10-25), ms per layer and velocity against diffusers fp32 at 896²:
/// GPU alone 145 ms (3.7e-4); GPU 19 / CPU 13 heads 91 ms (3.6e-4: the CPU's heads are fp32); GPU 14 / Neural Engine 8 /
/// CPU 10 88 ms (9.3e-4); GPU 16 / Neural Engine 16 112 ms (1.6e-3). Beside the Neural Engine the GPU's heads slow
/// from 4.5 to 6.3–7.0 ms each (they share the memory and its cache), so its heads buy ~1.5 % for 2.5× the error:
/// off unless `KOKON_ANE_ATTENTION=1`.
///
///     heads [0, g)            GPU, `flash_attention` with its grid on those heads
///     heads [g, g + a)        Neural Engine, fp16, in programs of 4 heads × 1 024 queries (`NeuralEngineAttention`):
///                             the GPU packs q (scaled), k, v head-first into their surfaces and unpacks y
///     heads [g + a, 32)       CPU, `CPUAttention` on the AMX worker's thread, straight into `attended`
///
/// Each head is computed by one unit, so the cut reorders no sum. Only the target's queries are cut: a text segment
/// is 32 rows, microseconds on the GPU.
struct HeadSplit: CustomStringConvertible {
    var gpu: Int, ane: Int, cpu: Int
    var description: String { "GPU \(gpu) / ANE \(ane) / CPU \(cpu) heads" }

    /// `KOKON_HEADS=gpu,ane,cpu` (the Neural Engine's a multiple of 4, the three summing to 32).
    static func fromEnvironment() -> HeadSplit? {
        guard let text = ProcessInfo.processInfo.environment["KOKON_HEADS"] else { return nil }
        let n = text.split(separator: ",").compactMap { Int($0) }
        guard n.count == 3, n.allSatisfy({ $0 >= 0 }), n.reduce(0, +) == QwenDiT.heads, n[1] % Coexecutor.aneHeadGroup == 0 else {
            FileHandle.standardError.write(Data("KOKON_HEADS=\(text) ignored: gpu,ane,cpu summing to 32, ane a multiple of 4\n".utf8))
            return nil
        }
        return HeadSplit(gpu: n[0], ane: n[1], cpu: n[2])
    }
}

/// One Neural Engine attention program and GPU views of its surfaces.
struct AttentionSlot {
    let program: NeuralEngineAttention
    let q: MTLBuffer, k: MTLBuffer, v: MTLBuffer, y: MTLBuffer
}

extension Coexecutor {
    static let aneHeadGroup = 4, aneQueryChunk = 1024
    /// The performance cores: `probe-attention` on the M2 Pro, 4 heads: 8 threads 27 ms, 12 the same, 4 threads 35.
    static let cpuThreads: Int = {
        var n: Int32 = 0, size = MemoryLayout<Int32>.size
        return sysctlbyname("hw.perflevel0.physicalcpu", &n, &size, nil, 0) == 0 && n > 0 ? Int(n) : 4
    }()

    /// Whether the target's attention takes the cut (below 1 024 queries the rendezvous costs more than it brings).
    func attentionApplies(queries: Int) -> Bool { queries >= 1024 && heads.gpu < QwenDiT.heads }

    /// The Neural Engine's programs for `queries` target rows on `keys` keys: per group of 4 heads, one program per
    /// chunk of 1 024 queries (the last one shorter, a multiple of 64), sharing the group's k and v surfaces.
    /// Groups are added or dropped to follow `heads.ane` (a group's programs do not depend on which heads it takes).
    func prepareAttention(queries: Int, keys: Int) throws {
        if attentionShape != (queries, keys) { attentionGroups = [] }
        attentionShape = (queries, keys)
        let wanted = heads.ane / Coexecutor.aneHeadGroup
        if attentionGroups.count > wanted { attentionGroups.removeLast(attentionGroups.count - wanted) }
        let device = context.device
        while attentionGroups.count < wanted {
            var slots: [AttentionSlot] = []
            for start in stride(from: 0, to: queries, by: Coexecutor.aneQueryChunk) {
                let rows = (min(Coexecutor.aneQueryChunk, queries - start) + 63) / 64 * 64
                let p = try NeuralEngineAttention(heads: Coexecutor.aneHeadGroup, queries: rows, keys: keys, sharing: slots.first?.program)
                let first = slots.first
                slots.append(AttentionSlot(program: p, q: try p.gpuBuffer(p.q, device: device),
                                           k: try first?.k ?? p.gpuBuffer(p.k, device: device),
                                           v: try first?.v ?? p.gpuBuffer(p.v, device: device),
                                           y: try p.gpuBuffer(p.y, device: device)))
                try p.run()   // compile and warm
            }
            attentionGroups.append(slots)
        }
    }

    struct HeadsShape { var stride, column0, rows, valid, row0, heads: UInt32; var factor: Float }
    typealias Operand = (buffer: MTLBuffer, offset: Int, pointer: UnsafeMutablePointer<Float>)

    /// Encodes the cut attention of `queries` target rows (`q`, `out` at the first of them) on `keys` keys (`k`, `v`
    /// at row 0), rows of `stride` floats. `gpuHeads` encodes the GPU's heads `[0, g)`.
    func encodeAttention(q: Operand, k: Operand, v: Operand, out: Operand, queries: Int, keys: Int, stride: Int,
                         commands: MTLCommandBuffer, gpuHeads: (Int) throws -> Void) throws {
        try prepareAttention(queries: queries, keys: keys)
        let split = heads, d = NeuralEngineAttention.headDim, group = Coexecutor.aneHeadGroup
        let scale = 1 / Float(d).squareRoot()
        counter += 1
        let p = counter
        open(p, kind: "attention", shares: (split.gpu, split.cpu, split.ane))
        func move(_ kernel: String, _ src: (MTLBuffer, Int), _ dst: (MTLBuffer, Int), _ shape: HeadsShape) throws {
            var s = shape
            let e = commands.makeComputeCommandEncoder()!
            e.label = kernel
            e.setComputePipelineState(try context.pipeline(kernel))
            e.setBuffer(src.0, offset: src.1, index: 0); e.setBuffer(dst.0, offset: dst.1, index: 1)
            e.setBytes(&s, length: MemoryLayout<HeadsShape>.stride, index: 2)
            e.dispatchThreads(MTLSize(width: d, height: Int(kernel == "ane_heads_pack" ? s.rows : s.valid), depth: Int(s.heads)),
                              threadsPerThreadgroup: MTLSize(width: 128, height: 2, depth: 1))
            e.endEncoding()
        }
        func shape(_ g: Int, rows: Int, valid: Int, row0: Int, factor: Float = 1) -> HeadsShape {
            HeadsShape(stride: UInt32(stride), column0: UInt32((split.gpu + g * group) * d), rows: UInt32(rows),
                       valid: UInt32(valid), row0: UInt32(row0), heads: UInt32(group), factor: factor)
        }
        for (g, slots) in attentionGroups.enumerated() {
            try move("ane_heads_pack", (k.buffer, k.offset), (slots[0].k, 0), shape(g, rows: keys, valid: keys, row0: 0))
            try move("ane_heads_pack", (v.buffer, v.offset), (slots[0].v, 0), shape(g, rows: keys, valid: keys, row0: 0))
            for (c, slot) in slots.enumerated() {
                let row0 = c * Coexecutor.aneQueryChunk
                try move("ane_heads_pack", (q.buffer, q.offset), (slot.q, 0),
                          shape(g, rows: slot.program.queries, valid: min(slot.program.queries, queries - row0), row0: row0, factor: scale))
            }
        }
        if split.ane > 0 || split.cpu > 0 { release(p, commands) }
        if split.cpu > 0 {
            nonisolated(unsafe) let (pq, pk, pv, po) = (q.pointer, k.pointer, v.pointer, out.pointer)
            let range = (split.gpu + split.ane)..<QwenDiT.heads
            amxWorker.submit { [self] in
                defer { amxDone.signaledValue = p }
                guard wait(ready, p, "CPU attention") else { return }
                let t = DispatchTime.now().uptimeNanoseconds
                CPUAttention.attend(q: pq, k: pk, v: pv, out: po, stride: stride, queries: queries, keys: keys,
                                    heads: range, scale: scale, threads: Coexecutor.cpuThreads)
                finished(p, \.amx, since: t)
            }
        }
        if split.ane > 0 {
            let programs = attentionGroups.flatMap { $0.map(\.program) }
            aneWorker.submit { [self] in
                defer { aneDone.signaledValue = p }
                guard wait(ready, p, "Neural Engine attention") else { return }
                let t = DispatchTime.now().uptimeNanoseconds
                do { for program in programs { try program.run() } } catch { fail("Neural Engine attention: \(error)") }
                finished(p, \.ane, since: t)
            }
        }
        try gpuHeads(split.gpu)
        gpuFinished(p, commands)
        if split.cpu > 0 { commands.encodeWaitForEvent(amxDone, value: p) }
        if split.ane > 0 {
            commands.encodeWaitForEvent(aneDone, value: p)
            for (g, slots) in attentionGroups.enumerated() {
                for (c, slot) in slots.enumerated() {
                    let row0 = c * Coexecutor.aneQueryChunk
                    try move("ane_heads_unpack", (slot.y, 0), (out.buffer, out.offset),
                              shape(g, rows: slot.program.queries, valid: min(slot.program.queries, queries - row0), row0: row0))
                }
            }
        }
    }
}

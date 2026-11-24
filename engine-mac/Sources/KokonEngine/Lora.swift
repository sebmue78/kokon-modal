import Accelerate
import Foundation
import Metal
import MetalPerformanceShaders

/// One LoRA of a request: sd-server's `lora` entry, the path resolved in the engine's `--lora-model-dir`.
public struct LoraRequest: Equatable, Sendable {
    public let path: String
    public let multiplier: Float
    public init(path: String, multiplier: Float) { (self.path, self.multiplier) = (path, multiplier) }
}

/// **LoRAs on the DiT**, as sd-server applies them (`model/adapter/lora.hpp`): for each adapted Linear `W [n, k]`,
/// `W + s · up · down` with `down [r, k]`, `up [n, r]` and `s = multiplier · alpha / r` (a `.scale` tensor instead of
/// alpha / r; the file's top-level `alpha` metadata when the module has no alpha; else 1).
///
/// The engine unpacks every weight before its product (`QwenDiT.linear`), so the update is added to the unpacked
/// copy right there, on the GPU in the same command buffer (one MPS product, `alpha = s`, `beta = 1`), before any
/// unit reads it; the few weights unpacked on the CPU (`linearCPU`: timestep and modulation) get it with BLAS. The
/// file's weights are never changed, and nothing stays merged between images.
///
/// Plain LoRAs only (`lora_A`/`lora_B`, `lora_down`/`lora_up`, kohya's `lora_unet_` names): LoHa, LoKr, DoRA and
/// full weight differences are refused (sd-server runs them). Kokon's copies already have fused `gate_up` pairs
/// split into `gate_layer` and `proj` (`lora.rs`), which `QwenDiT.weight` maps onto both file layouts.
final class LoraSet {
    struct Factor {
        let down: MTLBuffer   // [r, k] fp16
        let up: MTLBuffer     // [n, r] fp16
        let rank, k, n: Int
        let scale: Float
    }

    enum Failure: Error, CustomStringConvertible {
        case unsupported(String)
        var description: String {
            switch self { case .unsupported(let s): return s }
        }
    }

    let requests: [LoraRequest]
    /// By the DiT's weight name (`transformer_blocks.0.attn.to_q.weight`), in the requests' order.
    private(set) var factors: [String: [Factor]] = [:]
    /// Modules matched and modules of the files that are no weight of this model.
    private(set) var applied = 0, unmatched: [String] = []
    /// Tells the weights with an update apart in caches keyed by weight name (the Neural Engine's column scales).
    let key: String
    private let device: MTLDevice
    private var products: [String: MPSMatrixMultiplication] = [:]

    static let prefixes = ["base_model.model.", "model.diffusion_model.", "diffusion_model.", "transformer.", "unet."]
    static let downSuffixes = [".lora_A.default.weight", ".lora_A.weight", ".lora_down.weight"]
    static let upSuffixes = [".lora_B.default.weight", ".lora_B.weight", ".lora_up.weight"]
    static let refused = [".dora_scale", ".lora_magnitude_vector", ".diff", ".diff_b", ".hada_", ".lokr_", ".lora_mid"]

    /// `shape`: the model's Linear weight `[n, k]` (rows, columns) by weight name, nil for a name it does not have.
    init(_ requests: [LoraRequest], device: MTLDevice, shape: (String) -> (n: Int, k: Int)?) throws {
        self.requests = requests
        self.device = device
        key = requests.map { "\($0.path)@\($0.multiplier)" }.joined(separator: "|")
        // kohya's underscored module names, by the model's names (dots and underscores both become "_").
        var underscored: [String: String] = [:]
        for request in requests {
            let file = try SafetensorsFile(path: request.path)
            if let bad = file.tensors.keys.first(where: { name in LoraSet.refused.contains { name.contains($0) } }) {
                throw Failure.unsupported("\((request.path as NSString).lastPathComponent): \(bad) — this kind of LoRA "
                                          + "(LoHa, LoKr, DoRA or full weights) runs on the standard engine only")
            }
            let metadataAlpha = file.metadata["alpha"].flatMap(Float.init)
            for (name, tensor) in file.tensors {
                guard let suffix = LoraSet.downSuffixes.first(where: { name.hasSuffix($0) }) else { continue }
                let module = String(name.dropLast(suffix.count))
                guard let up = LoraSet.upSuffixes.lazy.map({ module + $0 }).first(where: { file.tensors[$0] != nil }) else {
                    unmatched.append(module)
                    continue
                }
                guard let weight = LoraSet.weightName(module, shape: shape, underscored: &underscored),
                      let dims = shape(weight) else {
                    unmatched.append(module)
                    continue
                }
                let (n, k) = (dims.n, dims.k)
                let upTensor = file.tensors[up]!
                guard tensor.shape.count == 2, upTensor.shape.count == 2, tensor.shape[1] == k, upTensor.shape[0] == n,
                      upTensor.shape[1] == tensor.shape[0] else {
                    throw Failure.unsupported("\((request.path as NSString).lastPathComponent): \(module) is \(upTensor.shape) · "
                                              + "\(tensor.shape), the model's \(weight) is [\(n), \(k)]")
                }
                let rank = tensor.shape[0]
                var scale: Float = metadataAlpha.map { $0 / Float(rank) } ?? 1
                if file.tensors[module + ".scale"] != nil, let s = try file.floats(module + ".scale").first {
                    scale = s
                } else if file.tensors[module + ".alpha"] != nil, let a = try file.floats(module + ".alpha").first {
                    scale = a / Float(rank)
                }
                let factor = Factor(down: try LoraSet.half(try file.floats(name), device: device, label: "LoRA down \(module)"),
                                    up: try LoraSet.half(try file.floats(up), device: device, label: "LoRA up \(module)"),
                                    rank: rank, k: k, n: n, scale: scale * request.multiplier)
                factors[weight, default: []].append(factor)
                applied += 1
            }
        }
    }

    /// The model's weight name of a LoRA module (`transformer_blocks.0.attn.to_q` → `….to_q.weight`).
    static func weightName(_ module: String, shape: (String) -> (n: Int, k: Int)?, underscored: inout [String: String]) -> String? {
        if module.hasPrefix("lora_unet_") {
            let flat = String(module.dropFirst("lora_unet_".count))
            if underscored.isEmpty {
                // Every Linear of the DiT: its blocks' and the few outside them.
                for name in QwenDiT.linearNames() where shape(name) != nil {
                    underscored[String(name.dropLast(".weight".count)).replacingOccurrences(of: ".", with: "_")] = name
                }
            }
            return underscored[flat]
        }
        let bare = prefixes.first(where: { module.hasPrefix($0) }).map { String(module.dropFirst($0.count)) } ?? module
        let name = bare + ".weight"
        return shape(name) != nil ? name : nil
    }

    static func half(_ values: [Float], device: MTLDevice, label: String) throws -> MTLBuffer {
        let halves = values.map { Float16($0) }
        guard let b = halves.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: max($0.count, 16), options: .storageModeShared) }) else {
            throw MetalContext.Failure.buffer("\(label): no memory")
        }
        b.label = label
        return b
    }

    func has(_ weight: String) -> Bool { factors[weight] != nil }

    /// Adds the updates of `weight` to its unpacked copy `[k, n]` (row i, column j: `W[j, i]`) at `w`.
    func add(_ weight: String, into w: (buffer: MTLBuffer, offset: Int), half: Bool, commands: MTLCommandBuffer) {
        guard let list = factors[weight] else { return }
        for f in list {
            let key = "\(f.k)×\(f.n)×\(f.rank)×\(f.scale)"
            let product: MPSMatrixMultiplication
            if let p = products[key] { product = p } else {
                // [k, r] · [r, n]: down and up read transposed.
                product = MPSMatrixMultiplication(device: device, transposeLeft: true, transposeRight: true, resultRows: f.k,
                                                  resultColumns: f.n, interiorColumns: f.rank, alpha: Double(f.scale), beta: 1)
                products[key] = product
            }
            let down = MPSMatrix(buffer: f.down, descriptor: MPSMatrixDescriptor(rows: f.rank, columns: f.k, rowBytes: f.k * 2, dataType: .float16))
            let up = MPSMatrix(buffer: f.up, descriptor: MPSMatrixDescriptor(rows: f.n, columns: f.rank, rowBytes: f.rank * 2, dataType: .float16))
            let result = MPSMatrix(buffer: w.buffer, offset: w.offset,
                                   descriptor: MPSMatrixDescriptor(rows: f.k, columns: f.n, rowBytes: f.n * (half ? 2 : 4),
                                                                   dataType: half ? .float16 : .float32))
            product.encode(commandBuffer: commands, leftMatrix: down, rightMatrix: up, resultMatrix: result)
        }
    }

    /// The same for a weight unpacked on the CPU as `[n, k]` (row-major, the file's own layout).
    func addCPU(_ weight: String, into w: inout [Float]) {
        guard let list = factors[weight] else { return }
        for f in list {
            let down = LoraSet.floats(f.down, count: f.rank * f.k), up = LoraSet.floats(f.up, count: f.n * f.rank)
            // W[n, k] += s · up[n, r] · down[r, k]
            cblas_sgemm(CblasRowMajor, CblasNoTrans, CblasNoTrans, Int32(f.n), Int32(f.k), Int32(f.rank), f.scale,
                        up, Int32(f.rank), down, Int32(f.k), 1, &w, Int32(f.k))
        }
    }

    static func floats(_ b: MTLBuffer, count: Int) -> [Float] {
        let p = b.contents().bindMemory(to: Float16.self, capacity: count)
        return (0..<count).map { Float(p[$0]) }
    }
}

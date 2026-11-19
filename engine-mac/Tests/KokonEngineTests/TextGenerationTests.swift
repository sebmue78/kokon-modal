import XCTest
@testable import KokonEngine

/// Text generation's sampler, which must draw what sd.cpp's draws for a seed (`src/runtime/text_sampler.cpp`).
final class TextGenerationTests: XCTestCase {
    /// The C++ standard fixes mt19937_64's output: the 10 000th number from the default seed 5489.
    func testMersenneTwisterIsTheStandards() {
        var random = MersenneTwister64(seed: 5489)
        XCTAssertEqual(random.next(), 14_514_284_786_278_117_030)
        for _ in 2..<10_000 { _ = random.next() }
        XCTAssertEqual(random.next(), 9_981_545_732_273_789_042)
    }

    func testGreedyTakesTheLowestIDOnTiesAndPenalizesSeenTokens() {
        var sampler = TextSampler(TextSampler.Parameters(temperature: 0, topP: 1, topK: 0, presencePenalty: 1.5), seed: 1)
        let logits: [Float] = [1, 3, 3, 2]
        XCTAssertEqual(logits.withUnsafeBufferPointer { sampler.sample($0.baseAddress!, count: 4) }, 1)
        // 1 was generated: 3 − 1.5 < 3, so 2 wins.
        XCTAssertEqual(logits.withUnsafeBufferPointer { sampler.sample($0.baseAddress!, count: 4) }, 2)
        // Both penalized to 1.5: 3 (logit 2) wins.
        XCTAssertEqual(logits.withUnsafeBufferPointer { sampler.sample($0.baseAddress!, count: 4) }, 3)
    }

    func testCandidatesTopKTemperatureTopP() {
        let sampler = TextSampler(TextSampler.Parameters(temperature: 0.5, topP: 0.8, topK: 3, presencePenalty: 0), seed: 1)
        let logits: [Float] = [0, 2, 1, 2, -1]
        let c = logits.withUnsafeBufferPointer { sampler.candidates($0.baseAddress!, count: 5) }
        // Top 3 by logit (ties by id): 1, 3, 2; at T 0.5 their weights are 1, 1, e^-2; 1 + 1 reach 0.8 of the sum.
        XCTAssertEqual(c.map(\.token), [1, 3])
        XCTAssertEqual(c[0].p, 0.5, accuracy: 1e-12)
        let all = TextSampler(TextSampler.Parameters(temperature: 1, topP: 1, topK: 0, presencePenalty: 0), seed: 1)
        let p = logits.withUnsafeBufferPointer { all.candidates($0.baseAddress!, count: 5) }
        XCTAssertEqual(p.map(\.token), [1, 3, 2, 0, 4])
        XCTAssertEqual(p.reduce(0) { $0 + $1.p }, 1, accuracy: 1e-12)
        XCTAssertEqual(p[2].p / p[0].p, exp(-1), accuracy: 1e-12)
    }

    /// A draw is the first candidate whose cumulative probability passes a uniform double of 53 bits from the seed.
    func testDrawFollowsTheSeed() {
        let parameters = TextSampler.Parameters(temperature: 1, topP: 1, topK: 0, presencePenalty: 0)
        let logits: [Float] = [0, 0]   // 0.5 each: token 0 when u < 0.5
        for seed: UInt64 in [1, 2, 3, 42] {
            var sampler = TextSampler(parameters, seed: seed)
            var random = MersenneTwister64(seed: seed)
            let u = Double(random.next() >> 11) / 9_007_199_254_740_992.0
            XCTAssertEqual(logits.withUnsafeBufferPointer { sampler.sample($0.baseAddress!, count: 2) }, u < 0.5 ? 0 : 1)
        }
    }

    func testTemplateIsSdcpps() {
        XCTAssertEqual(QwenTextGenerator.template(system: "S", prompt: "P"),
                       "<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nP<|im_end|>\n<|im_start|>assistant\n")
        XCTAssertEqual(QwenTextGenerator.template(system: "", prompt: "P"), "<|im_start|>user\nP<|im_end|>\n<|im_start|>assistant\n")
    }
}

/// The decode's matrix-vector products on Q4_K, Q6_K and Q8_0 blocks against the CPU's unpacking (`Dequant.row`) and a dot
/// product in double: random blocks with sane scales, 3 blocks a row (ragged across the SIMD group's lanes).
final class MatvecKernelTests: XCTestCase {
    func testMatvecMatchesTheUnpackedRows() throws {
        let context = try MetalContext()
        var s: UInt64 = 7
        func next() -> UInt64 { s = s &* 6364136223846793005 &+ 1442695040888963407; return s >> 33 }
        for (type, kernel) in [(QuantType.q4_K, "matvec_q4_K"), (.q6_K, "matvec_q6_K"), (.q8_0, "matvec_q8_0")] {
            XCTAssertEqual(QwenTextGenerator.matvecKernel(type), kernel)
            let blocks = 3 * 256 / type.blockValues
            let rows = 37, columns = 3 * 256, rowBytes = type.bytes(count: columns)
            var bytes = (0..<(rows * rowBytes)).map { _ in UInt8(truncatingIfNeeded: next()) }
            // The fp16 scales of every block: small positive values (random bytes may be NaN or huge).
            for r in 0..<rows {
                for b in 0..<blocks {
                    let block = r * rowBytes + b * type.blockBytes
                    let scaleOffsets = type == .q4_K ? [0, 2] : type == .q6_K ? [208] : [0]
                    for o in scaleOffsets {
                        let v = Float16(Float(next() % 1000 + 1) * 1e-5)
                        withUnsafeBytes(of: v.bitPattern.littleEndian) { bytes[block + o] = $0[0]; bytes[block + o + 1] = $0[1] }
                    }
                }
            }
            let x = (0..<columns).map { _ in Float(Int(next() % 2001) - 1000) / 500 }
            let w = try context.scratch(bytes.count, label: "w"), xb = try context.scratch(columns * 4, label: "x"), y = try context.scratch(rows * 4, label: "y")
            w.contents().copyMemory(from: bytes, byteCount: bytes.count)
            xb.contents().copyMemory(from: x, byteCount: columns * 4)
            let commands = context.queue.makeCommandBuffer()!
            let e = commands.makeComputeCommandEncoder()!
            e.setComputePipelineState(try context.pipeline(kernel))
            e.setBuffer(w, offset: 0, index: 0); e.setBuffer(xb, offset: 0, index: 1); e.setBuffer(y, offset: 0, index: 2)
            var params = QwenTextGenerator.MatvecParams(rows: UInt32(rows), blocksPerRow: UInt32(blocks), rowBytes: UInt32(rowBytes))
            e.setBytes(&params, length: MemoryLayout<QwenTextGenerator.MatvecParams>.stride, index: 3)
            let perGroup = QwenTextGenerator.matvecRows(type)
            e.dispatchThreadgroups(MTLSize(width: (rows + perGroup - 1) / perGroup, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 128, height: 1, depth: 1))
            e.endEncoding()
            try MetalContext.finish(commands, kernel)
            let got = y.contents().assumingMemoryBound(to: Float.self)
            var unpacked = [Float](repeating: 0, count: columns)
            for r in 0..<rows {
                bytes.withUnsafeBytes { Dequant.row($0.baseAddress! + r * rowBytes, type: type, count: columns, into: &unpacked) }
                let want = zip(unpacked, x).reduce(0.0) { $0 + Double($1.0) * Double($1.1) }
                let scale = zip(unpacked, x).reduce(0.0) { $0 + abs(Double($1.0) * Double($1.1)) }
                XCTAssertEqual(Double(got[r]), want, accuracy: 1e-5 * scale + 1e-9, "\(kernel) row \(r)")
            }
        }
    }
}

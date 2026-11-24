import Metal
import XCTest
@testable import KokonEngine

/// LoRAs on the DiT (`Lora.swift`): the files read as sd-server reads them, the updates added on the GPU and the CPU.
final class LoraTests: XCTestCase {
    /// A safetensors file of fp32 tensors (and optional metadata).
    static func write(_ tensors: [(String, [Int], [Float])], metadata: [String: String] = [:]) throws -> String {
        var header: [String: Any] = [:]
        var data = Data()
        for (name, shape, values) in tensors {
            let start = data.count
            values.withUnsafeBytes { data.append(contentsOf: $0) }
            header[name] = ["dtype": "F32", "shape": shape, "data_offsets": [start, data.count]]
        }
        if !metadata.isEmpty { header["__metadata__"] = metadata }
        var json = try JSONSerialization.data(withJSONObject: header)
        while json.count % 8 != 0 { json.append(0x20) }
        var file = Data()
        withUnsafeBytes(of: UInt64(json.count).littleEndian) { file.append(contentsOf: $0) }
        file.append(json)
        file.append(data)
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("lora-\(UUID().uuidString).safetensors").path
        try file.write(to: URL(fileURLWithPath: path))
        return path
    }

    static let (n, k, r) = (6, 8, 2)
    static let q = "transformer_blocks.0.attn.to_q.weight", mod = "modulation.1.weight"
    /// The model's Linear weights the tests know: `[n, k]` each.
    static func shape(_ name: String) -> (n: Int, k: Int)? { [q, mod].contains(name) ? (n, k) : nil }

    static func values(_ count: Int, _ seed: Float) -> [Float] { (0..<count).map { Float(($0 * 7 + Int(seed * 13)) % 11) / 8 - 0.6 } }

    /// `W[n, k] + s · up[n, r] · down[r, k]`, plainly.
    static func merged(_ w: [Float], down: [Float], up: [Float], scale: Float) -> [Float] {
        var out = w
        for j in 0..<n { for i in 0..<k { for t in 0..<r { out[j * k + i] += scale * up[j * r + t] * down[t * k + i] } } }
        return out
    }

    func testNamesAlphaAndScalesAsSdServerReadsThem() throws {
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
        let down = LoraTests.values(LoraTests.r * LoraTests.k, 1), up = LoraTests.values(LoraTests.n * LoraTests.r, 2)
        let (n, k, r) = (LoraTests.n, LoraTests.k, LoraTests.r)
        // Diffusers' names with alpha 4 (s = 4 / 2), kohya's with no alpha but the metadata's (s = 1 / 2), a module the
        // model does not have.
        let path = try LoraTests.write([
            ("transformer.transformer_blocks.0.attn.to_q.lora_A.weight", [r, k], down),
            ("transformer.transformer_blocks.0.attn.to_q.lora_B.weight", [n, r], up),
            ("transformer.transformer_blocks.0.attn.to_q.alpha", [], [4]),
            ("lora_unet_modulation_1.lora_down.weight", [r, k], down),
            ("lora_unet_modulation_1.lora_up.weight", [n, r], up),
            ("transformer.transformer_blocks.0.attn.add_q_proj.lora_A.weight", [r, k], down),
            ("transformer.transformer_blocks.0.attn.add_q_proj.lora_B.weight", [n, r], up),
        ], metadata: ["alpha": "1"])
        let set = try LoraSet([LoraRequest(path: path, multiplier: 0.5)], device: device, shape: LoraTests.shape)
        XCTAssertEqual(set.applied, 2)
        XCTAssertEqual(set.unmatched, ["transformer.transformer_blocks.0.attn.add_q_proj"])
        XCTAssertEqual(set.factors[LoraTests.q]?.first?.scale, 0.5 * 4 / 2)
        XCTAssertEqual(set.factors[LoraTests.mod]?.first?.scale, 0.5 * 1 / 2)
        XCTAssertTrue(set.has(LoraTests.q) && !set.has("proj_out.weight"))
    }

    func testOtherKindsAndWrongShapesAreRefused() throws {
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
        let (n, k, r) = (LoraTests.n, LoraTests.k, LoraTests.r)
        let loha = try LoraTests.write([("transformer_blocks.0.attn.to_q.hada_w1_a", [r, k], LoraTests.values(r * k, 1))])
        XCTAssertThrowsError(try LoraSet([LoraRequest(path: loha, multiplier: 1)], device: device, shape: LoraTests.shape))
        let wrong = try LoraTests.write([("transformer_blocks.0.attn.to_q.lora_A.weight", [r, k + 1], LoraTests.values(r * (k + 1), 1)),
                                         ("transformer_blocks.0.attn.to_q.lora_B.weight", [n, r], LoraTests.values(n * r, 2))])
        XCTAssertThrowsError(try LoraSet([LoraRequest(path: wrong, multiplier: 1)], device: device, shape: LoraTests.shape))
    }

    /// The update on the unpacked copy `[k, n]` (fp16 and fp32) and on the CPU's `[n, k]`, against the plain sum.
    func testUpdatesMatchThePlainSum() throws {
        let context = try MetalContext()
        let (n, k, r) = (LoraTests.n, LoraTests.k, LoraTests.r)
        let down = LoraTests.values(r * k, 3), up = LoraTests.values(n * r, 4), w = LoraTests.values(n * k, 5)
        let path = try LoraTests.write([("diffusion_model.transformer_blocks.0.attn.to_q.lora_down.weight", [r, k], down),
                                        ("diffusion_model.transformer_blocks.0.attn.to_q.lora_up.weight", [n, r], up)])
        // Two LoRAs on one weight add up, each at its strength.
        let set = try LoraSet([LoraRequest(path: path, multiplier: 0.75), LoraRequest(path: path, multiplier: 0.5)],
                              device: context.device, shape: LoraTests.shape)
        // fp16 inputs: the reference uses the values as the GPU sees them.
        let h = { (v: [Float]) in v.map { Float(Float16($0)) } }
        let want = LoraTests.merged(LoraTests.merged(w, down: h(down), up: h(up), scale: 0.75), down: h(down), up: h(up), scale: 0.5)

        var cpu = w
        set.addCPU(LoraTests.q, into: &cpu)
        for (a, b) in zip(cpu, want) { XCTAssertEqual(a, b, accuracy: 1e-5) }

        for half in [true, false] {
            let bytes = k * n * (half ? 2 : 4)
            let buffer = try context.scratch(bytes + 64, label: "w")
            // [k, n]: row i, column j holds W[j, i]; written after 64 bytes, as a reserve sits in the arena.
            for i in 0..<k {
                for j in 0..<n {
                    if half {
                        (buffer.contents() + 64).bindMemory(to: Float16.self, capacity: k * n)[i * n + j] = Float16(w[j * k + i])
                    } else {
                        (buffer.contents() + 64).bindMemory(to: Float.self, capacity: k * n)[i * n + j] = w[j * k + i]
                    }
                }
            }
            let commands = try XCTUnwrap(context.queue.makeCommandBuffer())
            set.add(LoraTests.q, into: (buffer, 64), half: half, commands: commands)
            set.add("proj_out.weight", into: (buffer, 64), half: half, commands: commands)   // no update: nothing
            commands.commit()
            commands.waitUntilCompleted()
            for i in 0..<k {
                for j in 0..<n {
                    let got = half ? Float((buffer.contents() + 64).bindMemory(to: Float16.self, capacity: k * n)[i * n + j])
                        : (buffer.contents() + 64).bindMemory(to: Float.self, capacity: k * n)[i * n + j]
                    XCTAssertEqual(got, want[j * k + i], accuracy: half ? 4e-3 : 1e-4, "half \(half) [\(i), \(j)]")
                }
            }
        }
    }

    func testRequestsTakeLorasFromTheirFolderOnly() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("loras-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data([1]).write(to: dir.appendingPathComponent("a.safetensors"))
        func body(_ lora: [[String: Any]]) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["prompt": "p", "width": 256, "height": 256, "lora": lora])
        }
        let (r, reason) = EngineServer.ImageRequest.parse(try body([["path": "a.safetensors", "multiplier": 0.8]]), loraDir: dir.path)
        XCTAssertNil(reason)
        XCTAssertEqual(r?.loras, [LoraRequest(path: dir.appendingPathComponent("a.safetensors").standardizedFileURL.path, multiplier: 0.8)])
        XCTAssertNotNil(EngineServer.ImageRequest.parse(try body([["path": "a.safetensors"]])).1, "no LoRA folder")
        XCTAssertNotNil(EngineServer.ImageRequest.parse(try body([["path": "../a.safetensors"]]), loraDir: dir.path).1)
        XCTAssertNotNil(EngineServer.ImageRequest.parse(try body([["path": "missing.safetensors"]]), loraDir: dir.path).1)
        XCTAssertEqual(EngineServer.ImageRequest.parse(try body([])).0?.loras, [])
    }
}

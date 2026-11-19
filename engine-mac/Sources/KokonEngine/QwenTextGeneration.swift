import Foundation
import Metal

/// **Text generation with the text encoder's LLM** (Prompt+): Qwen3-VL-8B's text decoder writes the prompt that the
/// image model gets, as Kokon's sd.cpp does (`src/pipeline/text.cpp`, `POST /sdcpp/v1/text_gen`), on the same file:
///
///     chat template ─ tokenizer ─ prefill: QwenTextEncoder.forward on every token, each layer's K and V into the cache
///     then per token: embedding row ─ 36 × { RMS ─ q, k, v ─ norms, RoPE at its position ─ into the cache ─ attention on
///                     the cache ─ o ─ RMS ─ gate, up ─ SwiGLU ─ down } ─ final RMSNorm ─ LM head ─ sampler ─ next token
///
/// The decode reads every weight once per token, so its products read the Q4_K / Q6_K / Q8_0 blocks where they lie in the
/// mapped file (`Kernels/decode.metal`), with no unpacking. Text only: images (edit Prompt+, Compose labels) need the
/// vision tower.
public final class QwenTextGenerator {
    /// sd.cpp's limit on prompt + generated tokens (`TEXT_GEN_MAX_CONTEXT`).
    public static let maxContext = 16384
    public static let vocabulary = 151_936

    public enum Finish: String { case stop, length, cancelled }
    public struct Result {
        public var text = ""
        public var finish = Finish.stop
        public var seed: Int64 = 0
        public var promptTokens = 0, generatedTokens = 0
        /// Seconds: tokenizing and buffers, prefill (to the first token), decode (first token to last), the vision tower.
        public var prepare = 0.0, prefill = 0.0, decode = 0.0, image = 0.0
        /// Every token sampled, the stop token included.
        public var tokens: [Int] = []
    }

    let encoder: QwenTextEncoder
    let context: MetalContext
    var file: GGUFFile { encoder.file }

    public init(encoder: QwenTextEncoder) {
        self.encoder = encoder
        context = encoder.context
    }

    /// sd.cpp's chat template for text generation (src/pipeline/text.cpp): the system turn when `system` is not empty;
    /// each image before the prompt as `<|vision_start|><|image_pad|><|vision_end|>`, labelled `<image1>`, ` <image2>`…
    /// when there are several.
    public static func template(system: String, prompt: String, images: Int = 0) -> String {
        let markers = (0..<images).map { i in
            (images > 1 ? (i == 0 ? "" : " ") + "<image\(i + 1)>" : "") + "<|vision_start|><|image_pad|><|vision_end|>"
        }.joined()
        return (system.isEmpty ? "" : "<|im_start|>system\n\(system)<|im_end|>\n") + "<|im_start|>user\n\(markers)\(prompt)<|im_end|>\n<|im_start|>assistant\n"
    }

    /// Writes the assistant's reply to `prompt`. `onPiece` gets the text as it is written (whole UTF-8 characters);
    /// returning false stops it (`cancelled`). `logits`: each step's logits, for the checks. `images`: the vision
    /// tower's outputs of the images shown before the prompt; their slots take 3D positions (`QwenTextEncoder.positions`),
    /// so the reply's positions run ahead of its cache slots by a fixed offset.
    public func generate(system: String, prompt: String, images: [QwenVisionTower.Output] = [], maxTokens: Int,
                         sampling: TextSampler.Parameters, seed: Int64, onPiece: (String) -> Bool = { _ in true },
                         logits: ((Int, UnsafePointer<Float>) -> Void)? = nil) throws -> Result {
        var result = Result()
        let started = DispatchTime.now().uptimeNanoseconds
        func since(_ t: UInt64) -> Double { Double(DispatchTime.now().uptimeNanoseconds - t) * 1e-9 }
        let tokenizer = encoder.tokenizer
        guard let imEnd = tokenizer.id(of: "<|im_end|>"), let endOfText = tokenizer.id(of: "<|endoftext|>") else {
            throw GGUFFile.Failure.unsupported("the tokenizer has no <|im_end|> or <|endoftext|>")
        }
        let stops: Set<Int> = [imEnd, endOfText]
        let ids = encoder.expand(tokenizer.encode(QwenTextGenerator.template(system: system, prompt: prompt, images: images.count)),
                                 images: images)
        let positions = try QwenTextEncoder.positions(ids: ids, imagePad: images.isEmpty ? -1 : encoder.imagePad,
                                                      grids: images.map { ($0.height / 32, $0.width / 32) })
        let offset = Int(positions.last.map { $0[0] + 1 } ?? 0) - ids.count   // 0 for text: position = slot
        let capacity = ids.count + maxTokens
        guard capacity <= QwenTextGenerator.maxContext else {
            throw GGUFFile.Failure.unsupported("prompt (\(ids.count) tokens) + max_tokens (\(maxTokens)) exceeds the \(QwenTextGenerator.maxContext)-token limit")
        }
        result.promptTokens = ids.count
        result.seed = seed >= 0 ? seed : Int64.random(in: 0...0x7fff_ffff)
        var sampler = TextSampler(sampling, seed: UInt64(bitPattern: result.seed))
        let cache = try KVCache(context: context, layers: QwenTextEncoder.layers, kvHeads: QwenTextEncoder.kvHeads, capacity: capacity)
        let step = try Decoder(generator: self, cache: cache, positionOffset: offset)
        result.prepare = since(started)

        // Prefill: the prompt's K and V into the cache, the last row's hidden state to the head.
        var t = DispatchTime.now().uptimeNanoseconds
        let hidden = try encoder.forward(ids: ids, cache: cache, images: images)
        var next = try step.head(hidden: Array(hidden[((ids.count - 1) * QwenTextEncoder.dim)...]))
        var stream = TokenStreamDecoder(tokenizer: tokenizer)
        while true {
            logits?(result.tokens.count, next)
            let token = sampler.sample(next, count: QwenTextGenerator.vocabulary)
            result.tokens.append(token)
            if result.tokens.count == 1 { result.prefill = since(t); t = DispatchTime.now().uptimeNanoseconds }
            if stops.contains(token) { result.finish = .stop; break }
            let piece = stream.push(token)
            if !piece.isEmpty {
                result.text += piece
                if !onPiece(piece) { result.finish = .cancelled; break }
            }
            if result.tokens.count == maxTokens { result.finish = .length; break }
            next = try step.token(token, position: ids.count + result.tokens.count - 1)
        }
        if result.finish != .cancelled {
            let rest = stream.flush()
            if !rest.isEmpty {
                result.text += rest
                if !onPiece(rest) { result.finish = .cancelled }
            }
        }
        result.decode = since(t)
        result.generatedTokens = result.tokens.count - (result.finish == .stop ? 1 : 0)
        context.release(file)
        return result
    }

    /// One token through the decoder layers and the head, on the GPU; the buffers live as long as one reply.
    final class Decoder {
        let generator: QwenTextGenerator
        let cache: KVCache
        let context: MetalContext
        let file: GGUFFile
        /// [x | normed | q | k | v | attended | o | gate | up] fp32, the layers' norm weights, the RoPE table, the logits.
        let state: MTLBuffer, norms: MTLBuffer, rope: MTLBuffer, logits: MTLBuffer
        let offsets: [String: Int]
        let embedding: GGUFTensor
        /// The GPU's seconds for the last token.
        var lastGPU = 0.0

        /// `positionOffset`: a slot's RoPE position minus the slot (images before the prompt).
        init(generator: QwenTextGenerator, cache: KVCache, positionOffset: Int = 0) throws {
            self.generator = generator
            self.cache = cache
            context = generator.context
            file = generator.file
            let d = QwenTextEncoder.dim, kv = QwenTextEncoder.kvHeads * QwenTextEncoder.headDim, h = QwenTextEncoder.hidden
            var offsets: [String: Int] = [:], at = 0
            for (name, floats) in [("x", d), ("normed", d), ("q", d), ("k", kv), ("v", kv), ("attended", d), ("o", d),
                                   ("gate", h), ("up", h)] {
                offsets[name] = at
                at += floats * 4
            }
            self.offsets = offsets
            state = try context.scratch(at, label: "decode state")
            // Per layer: input norm, post-attention norm, q norm (128), k norm (128); then the final norm.
            norms = try context.scratch((QwenTextEncoder.layers * (2 * d + 256) + d) * 4, label: "decode norms")
            let n = norms.contents().assumingMemoryBound(to: Float.self)
            for layer in 0..<QwenTextEncoder.layers {
                for (i, (name, count)) in [("attn_norm", d), ("ffn_norm", d), ("attn_q_norm", 128), ("attn_k_norm", 128)].enumerated() {
                    let w = try Dequant.array(file, "blk.\(layer).\(name).weight")
                    (n + layer * (2 * d + 256) + [0, d, 2 * d, 2 * d + 128][i]).update(from: w, count: count)
                }
            }
            (n + QwenTextEncoder.layers * (2 * d + 256)).update(from: try Dequant.array(file, "output_norm.weight"), count: d)
            let table = QwenTextEncoder.ropeTable(positions: (0..<cache.capacity).map { SIMD3(repeating: Int32($0 + positionOffset)) })
            rope = try context.scratch(table.count * 4, label: "decode rope")
            rope.contents().copyMemory(from: table, byteCount: table.count * 4)
            logits = try context.scratch(QwenTextGenerator.vocabulary * 4, label: "logits")
            embedding = try file.tensor("token_embd.weight")
        }

        func pointer(_ name: String) -> UnsafeMutablePointer<Float> {
            (state.contents() + offsets[name]!).assumingMemoryBound(to: Float.self)
        }

        /// The final norm and the LM head on `hidden` (one row): the logits.
        func head(hidden: [Float]) throws -> UnsafePointer<Float> {
            pointer("x").update(from: hidden, count: QwenTextEncoder.dim)
            let commands = try generator.encoder.begin()
            try encodeHead(commands)
            try MetalContext.finish(commands, "text generation head")
            return UnsafePointer(logits.contents().assumingMemoryBound(to: Float.self))
        }

        /// `token` at `position`: its K and V join the cache; the logits of the next one.
        func token(_ token: Int, position: Int) throws -> UnsafePointer<Float> {
            let d = QwenTextEncoder.dim
            guard let type = embedding.type, token >= 0, token < embedding.rows else { throw GGUFFile.Failure.unsupported("token id \(token)") }
            Dequant.row(file.data(embedding) + token * type.bytes(count: d), type: type, count: d, into: pointer("x"))
            let commands = try generator.encoder.begin()
            for layer in 0..<QwenTextEncoder.layers { try encodeLayer(layer, position: position, commands) }
            try encodeHead(commands)
            lastGPU = try MetalContext.finish(commands, "text generation step")
            return UnsafePointer(logits.contents().assumingMemoryBound(to: Float.self))
        }

        func encodeLayer(_ layer: Int, position: Int, _ commands: MTLCommandBuffer) throws {
            let d = QwenTextEncoder.dim, block = "blk.\(layer).", norm = layer * (2 * d + 256) * 4
            try rmsNorm("x", into: "normed", weight: norm, commands)
            try matvec(block + "attn_q.weight", "normed", "q", commands)
            try matvec(block + "attn_k.weight", "normed", "k", commands)
            try matvec(block + "attn_v.weight", "normed", "v", commands)
            for (name, heads, weight) in [("q", QwenTextEncoder.heads, norm + 2 * d * 4), ("k", QwenTextEncoder.kvHeads, norm + (2 * d + 128) * 4)] {
                try kernel("head_rmsnorm_rope_neox", commands) { e in
                    e.setBuffer(state, offset: offsets[name]!, index: 0)
                    e.setBuffer(norms, offset: weight, index: 1)
                    e.setBuffer(rope, offset: position * 128 * 4, index: 2)
                    var params = QwenDiT.HeadParams(heads: UInt32(heads), rows: 1, eps: QwenTextEncoder.eps)
                    e.setBytes(&params, length: MemoryLayout<QwenDiT.HeadParams>.stride, index: 3)
                    e.dispatchThreadgroups(MTLSize(width: (heads + 7) / 8, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
                }
            }
            try cache.store(layer: layer, k: (state, offsets["k"]!), v: (state, offsets["v"]!), rows: 1, position: position,
                            context: context, commands: commands)
            try kernel("decode_attention", commands) { e in
                e.setBuffer(state, offset: offsets["q"]!, index: 0)
                e.setBuffer(cache.buffer, offset: cache.offset(layer: layer, value: false), index: 1)
                e.setBuffer(cache.buffer, offset: cache.offset(layer: layer, value: true), index: 2)
                e.setBuffer(state, offset: offsets["attended"]!, index: 3)
                var params = DecodeAttentionParams(keys: UInt32(position + 1), capacity: UInt32(cache.capacity),
                                                   groups: UInt32(QwenTextEncoder.heads / QwenTextEncoder.kvHeads),
                                                   scale: 1 / Float(QwenTextEncoder.headDim).squareRoot())
                e.setBytes(&params, length: MemoryLayout<DecodeAttentionParams>.stride, index: 4)
                e.dispatchThreadgroups(MTLSize(width: QwenTextEncoder.heads, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
            }
            try matvec(block + "attn_output.weight", "attended", "o", commands)
            try add("o", count: d, commands)
            try rmsNorm("x", into: "normed", weight: norm + d * 4, commands)
            try matvec(block + "ffn_gate.weight", "normed", "gate", commands)
            try matvec(block + "ffn_up.weight", "normed", "up", commands)
            try kernel("swiglu", commands) { e in
                e.setBuffer(state, offset: offsets["gate"]!, index: 0)
                e.setBuffer(state, offset: offsets["up"]!, index: 1)
                var params = QwenDiT.SwigluParams(columns: UInt32(QwenTextEncoder.hidden), half: QwenDiT.fullOnly(1))
                e.setBytes(&params, length: MemoryLayout<QwenDiT.SwigluParams>.stride, index: 2)
                e.setBuffer(state, offset: offsets["gate"]!, index: 3)
                e.dispatchThreads(MTLSize(width: QwenTextEncoder.hidden, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
            }
            try matvec(block + "ffn_down.weight", "gate", "o", commands)
            try add("o", count: d, commands)
        }

        func encodeHead(_ commands: MTLCommandBuffer) throws {
            try rmsNorm("x", into: "normed", weight: QwenTextEncoder.layers * (2 * QwenTextEncoder.dim + 256) * 4, commands)
            let tensor = try file.tensor("output.weight")
            try matvec(tensor, x: (state, offsets["normed"]!), y: (logits, 0), commands)
        }

        func kernel(_ name: String, _ commands: MTLCommandBuffer, _ body: (MTLComputeCommandEncoder) throws -> Void) throws {
            try generator.encoder.compute(name, commands: commands, body)
        }

        func rmsNorm(_ input: String, into out: String, weight: Int, _ commands: MTLCommandBuffer) throws {
            try kernel("rmsnorm_rows", commands) { e in
                e.setBuffer(state, offset: offsets[input]!, index: 0)
                e.setBuffer(state, offset: offsets[out]!, index: 1)
                e.setBuffer(norms, offset: weight, index: 2)
                var params = QwenDiT.RowParams(columns: UInt32(QwenTextEncoder.dim), targetStart: 0, eps: QwenTextEncoder.eps)
                e.setBytes(&params, length: MemoryLayout<QwenDiT.RowParams>.stride, index: 3)
                e.dispatchThreadgroups(MTLSize(width: 1, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
            }
        }

        func add(_ y: String, count: Int, _ commands: MTLCommandBuffer) throws {
            try kernel("add_inplace", commands) { e in
                e.setBuffer(state, offset: offsets["x"]!, index: 0)
                e.setBuffer(state, offset: offsets[y]!, index: 1)
                var c = UInt32(count)
                e.setBytes(&c, length: 4, index: 2)
                e.dispatchThreads(MTLSize(width: count, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
            }
        }

        func matvec(_ name: String, _ x: String, _ y: String, _ commands: MTLCommandBuffer) throws {
            try matvec(try file.tensor(name), x: (state, offsets[x]!), y: (state, offsets[y]!), commands)
        }

        /// `y = W · x` on the weight's blocks in the mapped file.
        func matvec(_ tensor: GGUFTensor, x: (MTLBuffer, Int), y: (MTLBuffer, Int), _ commands: MTLCommandBuffer) throws {
            guard let type = tensor.type, let name = QwenTextGenerator.matvecKernel(type) else {
                throw GGUFFile.Failure.unsupported("\(tensor.name): \(tensor.type?.name ?? "?"), the decode reads Q4_K, Q6_K and Q8_0")
            }
            let (source, offset) = try context.buffer(for: tensor, in: file)
            try kernel(name, commands) { e in
                e.setBuffer(source, offset: offset, index: 0)
                e.setBuffer(x.0, offset: x.1, index: 1)
                e.setBuffer(y.0, offset: y.1, index: 2)
                var params = MatvecParams(rows: UInt32(tensor.rows), blocksPerRow: UInt32(tensor.columns / type.blockValues),
                                          rowBytes: UInt32(type.bytes(count: tensor.columns)))
                e.setBytes(&params, length: MemoryLayout<MatvecParams>.stride, index: 3)
                let rows = QwenTextGenerator.matvecRows(type)
                e.dispatchThreadgroups(MTLSize(width: (tensor.rows + rows - 1) / rows, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 128, height: 1, depth: 1))
            }
        }
    }

    struct MatvecParams { var rows, blocksPerRow, rowBytes: UInt32 }
    /// Rows per threadgroup of `matvec_*` (4 SIMD groups of MATVEC_Q4_ROWS or MATVEC_ROWS).
    static func matvecRows(_ type: QuantType) -> Int { type == .q4_K ? 16 : 8 }
    /// The decode's kernel for a weight type; nil for the types it does not read.
    static func matvecKernel(_ type: QuantType) -> String? {
        switch type {
        case .q4_K: return "matvec_q4_K"
        case .q6_K: return "matvec_q6_K"
        case .q8_0: return "matvec_q8_0"
        default: return nil
        }
    }
    struct DecodeAttentionParams { var keys, capacity, groups: UInt32; var scale: Float }
}

/// **The K/V cache** of text generation: per layer, K and V of every position so far, fp16 `[kvHeads, capacity, 128]`
/// each (144 KB a position for Qwen3-VL-8B, as sd.cpp's).
public final class KVCache {
    public let layers: Int, kvHeads: Int, capacity: Int
    let buffer: MTLBuffer

    init(context: MetalContext, layers: Int, kvHeads: Int, capacity: Int) throws {
        (self.layers, self.kvHeads, self.capacity) = (layers, kvHeads, capacity)
        buffer = try context.scratch(layers * 2 * kvHeads * capacity * 128 * 2, label: "K/V cache")
    }

    func offset(layer: Int, value: Bool) -> Int { ((layer * 2 + (value ? 1 : 0)) * kvHeads * capacity * 128) * 2 }

    struct Params { var rows, kvHeads, capacity, position: UInt32 }

    /// Encodes K and V of `rows` positions from `position` (rows `[rows, kvHeads · 128]` fp32) into layer `layer`.
    func store(layer: Int, k: (MTLBuffer, Int), v: (MTLBuffer, Int), rows: Int, position: Int, context: MetalContext,
               commands: MTLCommandBuffer) throws {
        guard position + rows <= capacity else { throw MetalContext.Failure.buffer("K/V cache: position \(position + rows) of \(capacity)") }
        let e = commands.makeComputeCommandEncoder()!
        e.label = "kv_store"
        e.setComputePipelineState(try context.pipeline("kv_store"))
        e.setBuffer(k.0, offset: k.1, index: 0)
        e.setBuffer(v.0, offset: v.1, index: 1)
        e.setBuffer(buffer, offset: offset(layer: layer, value: false), index: 2)
        e.setBuffer(buffer, offset: offset(layer: layer, value: true), index: 3)
        var params = Params(rows: UInt32(rows), kvHeads: UInt32(kvHeads), capacity: UInt32(capacity), position: UInt32(position))
        e.setBytes(&params, length: MemoryLayout<Params>.stride, index: 4)
        e.dispatchThreads(MTLSize(width: kvHeads * 128, height: rows, depth: 1), threadsPerThreadgroup: MTLSize(width: 128, height: 1, depth: 1))
        e.endEncoding()
    }
}

/// **The next-token sampler**, sd.cpp's (`src/runtime/text_sampler.cpp`) step for step so a seed writes the same text:
/// presence penalty (generated tokens only), then top-k, temperature, top-p, one draw from mt19937_64; temperature 0 is
/// greedy. Ties keep the lower token id first.
public struct TextSampler {
    public struct Parameters: Sendable {
        public var temperature: Float, topP: Float, topK: Int, presencePenalty: Float
        public init(temperature: Float, topP: Float, topK: Int, presencePenalty: Float) {
            (self.temperature, self.topP, self.topK, self.presencePenalty) = (temperature, topP, topK, presencePenalty)
        }
        public static let greedy = Parameters(temperature: 0, topP: 1, topK: 0, presencePenalty: 0)
    }

    let parameters: Parameters
    var random: MersenneTwister64
    /// Tokens generated so far, by id (dense, as sd.cpp's: the penalty is looked up for every token of the vocabulary).
    var seen: [Bool] = []

    public init(_ parameters: Parameters, seed: UInt64) {
        self.parameters = parameters
        random = MersenneTwister64(seed: seed)
    }

    var greedy: Bool { parameters.temperature <= 0 }

    /// A double in [0, 1) from 53 random bits.
    mutating func uniform() -> Double { Double(random.next() >> 11) * (1.0 / 9_007_199_254_740_992.0) }

    func penalized(_ logits: UnsafePointer<Float>, _ token: Int) -> Float {
        parameters.presencePenalty != 0 && token < seen.count && seen[token] ? logits[token] - parameters.presencePenalty : logits[token]
    }

    /// Probabilities after the penalty, top-k, temperature and top-p, by decreasing probability.
    func candidates(_ logits: UnsafePointer<Float>, count: Int) -> [(token: Int, p: Double)] {
        func before(_ a: (Int, Float), _ b: (Int, Float)) -> Bool { a.1 > b.1 || (a.1 == b.1 && a.0 < b.0) }
        var kept: [(Int, Float)]
        if parameters.topK > 0 && parameters.topK < count {
            // The k best in one pass, kept sorted (k is small, the vocabulary ~150k).
            let k = parameters.topK
            kept = []
            kept.reserveCapacity(k + 1)
            for i in 0..<count {
                let c = (i, penalized(logits, i))
                if kept.count == k, !before(c, kept[k - 1]) { continue }
                var at = kept.count
                while at > 0 && before(c, kept[at - 1]) { at -= 1 }
                kept.insert(c, at: at)
                if kept.count > k { kept.removeLast() }
            }
        } else {
            kept = (0..<count).map { ($0, penalized(logits, $0)) }
            kept.sort(by: before)
        }
        let inverse = parameters.temperature > 0 ? 1 / Double(parameters.temperature) : 1
        let top = Double(kept[0].1)
        var probs = kept.map { ($0.0, exp((Double($0.1) - top) * inverse)) }
        let sum = probs.reduce(0) { $0 + $1.1 }
        probs = probs.map { ($0.0, $0.1 / sum) }
        if parameters.topP < 1 {
            var cumulative = 0.0, keep = probs.count
            for (i, p) in probs.enumerated() {
                cumulative += p.1
                if cumulative >= Double(parameters.topP) { keep = i + 1; break }
            }
            probs.removeLast(probs.count - keep)
            let total = probs.reduce(0) { $0 + $1.1 }
            probs = probs.map { ($0.0, $0.1 / total) }
        }
        return probs.map { (token: $0.0, p: $0.1) }
    }

    /// Picks the next token and remembers it for the presence penalty.
    public mutating func sample(_ logits: UnsafePointer<Float>, count: Int) -> Int {
        var token = 0
        if greedy {
            var best = penalized(logits, 0)
            for i in 1..<count {
                let l = penalized(logits, i)
                if l > best { best = l; token = i }
            }
        } else {
            let probs = candidates(logits, count: count)
            let u = uniform()
            var cumulative = 0.0
            token = probs.last!.token
            for p in probs {
                cumulative += p.p
                if u < cumulative { token = p.token; break }
            }
        }
        if token >= seen.count { seen += [Bool](repeating: false, count: token + 1 - seen.count) }
        seen[token] = true
        return token
    }
}

/// `std::mt19937_64`, whose output the C++ standard fixes: the same seed draws the same numbers as sd.cpp.
public struct MersenneTwister64 {
    private var state = [UInt64](repeating: 0, count: 312)
    private var index = 312

    public init(seed: UInt64) {
        state[0] = seed
        for i in 1..<312 { state[i] = 6_364_136_223_846_793_005 &* (state[i - 1] ^ (state[i - 1] >> 62)) &+ UInt64(i) }
    }

    public mutating func next() -> UInt64 {
        if index >= 312 {
            for i in 0..<312 {
                let y = (state[i] & 0xFFFF_FFFF_8000_0000) | (state[(i + 1) % 312] & 0x7FFF_FFFF)
                var v = state[(i + 156) % 312] ^ (y >> 1)
                if y & 1 != 0 { v ^= 0xB502_6F5A_A966_19E9 }
                state[i] = v
            }
            index = 0
        }
        var x = state[index]
        index += 1
        x ^= (x >> 29) & 0x5555_5555_5555_5555
        x ^= (x << 17) & 0x71D6_7FFF_EDA6_0000
        x ^= (x << 37) & 0xFFF7_EEE0_0000_0000
        x ^= x >> 43
        return x
    }
}

/// Tokens to text as they come, sd.cpp's `TokenStreamDecoder`: special tokens skipped, bytes held back until they
/// complete a UTF-8 character, invalid bytes as U+FFFD.
public struct TokenStreamDecoder {
    let tokenizer: QwenTokenizer
    var pending: [UInt8] = []

    public init(tokenizer: QwenTokenizer) { self.tokenizer = tokenizer }

    public mutating func push(_ token: Int) -> String {
        guard let bytes = tokenizer.bytes(of: token) else { return "" }   // an added (special) token
        pending += bytes
        return take(end: false)
    }

    public mutating func flush() -> String { take(end: true) }

    mutating func take(end: Bool) -> String {
        var out: [UInt8] = []
        var at = 0
        while at < pending.count {
            let length = TokenStreamDecoder.sequenceLength(pending, at)
            if length > 0 {
                out += pending[at..<(at + length)]
                at += length
            } else if length == 0 && !end {
                break
            } else {
                out += [0xEF, 0xBF, 0xBD]
                at = length == 0 ? pending.count : at - length
            }
        }
        pending.removeFirst(at)
        return String(decoding: out, as: UTF8.self)
    }

    /// The length of the valid UTF-8 sequence at `at`; 0 if the bytes end inside a valid prefix; −n if its first n bytes
    /// are an invalid prefix (one U+FFFD, as Python does). sd.cpp's `utf8_sequence_length`.
    static func sequenceLength(_ s: [UInt8], _ at: Int) -> Int {
        let lead = s[at]
        if lead < 0x80 { return 1 }
        var (length, lo, hi): (Int, UInt8, UInt8) = (0, 0x80, 0xBF)
        switch lead {
        case 0xC2...0xDF: length = 2
        case 0xE0...0xEF: (length, lo, hi) = (3, lead == 0xE0 ? 0xA0 : 0x80, lead == 0xED ? 0x9F : 0xBF)
        case 0xF0...0xF4: (length, lo, hi) = (4, lead == 0xF0 ? 0x90 : 0x80, lead == 0xF4 ? 0x8F : 0xBF)
        default: return -1
        }
        for i in 1..<length {
            if at + i >= s.count { return 0 }
            if s[at + i] < lo || s[at + i] > hi { return -i }
            (lo, hi) = (0x80, 0xBF)
        }
        return length
    }
}

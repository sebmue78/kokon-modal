import Foundation

/// **The engine as a long-lived server speaking sd-server's `/sdcpp/v1` API**, so qls-core, the app, remote access
/// and MCP use it as they use sd-server (crates/qls-core/src/sdcpp.rs is the client):
///
///     GET  /sdcpp/v1/capabilities       the model, the modes and limits
///     POST /sdcpp/v1/img_gen            202 {id, kind, status, created, poll_url}: the job is queued
///     GET  /sdcpp/v1/jobs/{id}          {status: queued|generating|completed|failed|cancelled, result, error}
///     POST /sdcpp/v1/jobs/{id}/cancel   200 {status: cancelled}: a running image stops within a DiT layer
///     POST /sdcpp/v1/text_gen           Prompt+: the text encoder's LLM writes, streamed as Server-Sent Events
///
/// Text to image, edits (`ref_images`, with the vision projector given as `--llm_vision`; Prompt+ then also looks at
/// the images) and an init image with a mask (`init_image`, `mask_image`, `strength`: brushed edits, extending an
/// image); requests with LoRAs or a second pass are refused with 400 and say so. Jobs and text generation run one at a time;
/// what stays loaded between them depends on the Mac (`QwenPipeline.keepModels`).
///
/// Progress goes to stdout as sd-server's log lines, the ones qls-core's `ProgressParser` reads (process.rs):
/// `generate_image WxH`, `sampling using`, `generating image: i/n - seed s`, step bars `| i/n - x.xxs/it`,
/// `decoding 1 latents`, `generate_image completed in Xs`.
public final class EngineServer: @unchecked Sendable {
    public struct Paths: Sendable {
        public let diffusionModel, vae, textEncoder: String
        /// The vision tower (mmproj): edits need it.
        public let vision: String?
        /// sd-server's `--lora-model-dir`: a request's `lora` paths are relative to it. nil: no LoRAs.
        public let loraDir: String?
        public init(diffusionModel: String, vae: String, textEncoder: String, vision: String? = nil, loraDir: String? = nil) {
            self.diffusionModel = diffusionModel
            self.vae = vae
            self.textEncoder = textEncoder
            self.vision = vision
            self.loraDir = loraDir
        }
    }

    final class Job: @unchecked Sendable {
        let id: String
        let created: Int
        let request: ImageRequest
        var status = "queued"
        var started: Int?, completed: Int?
        var images: [String] = []
        var error: (code: String, message: String)?
        init(id: String, request: ImageRequest) {
            self.id = id
            self.request = request
            created = Int(Date().timeIntervalSince1970)
        }
    }

    /// The fields of `img_gen` the engine reads (sd-server's names), checked.
    struct ImageRequest: @unchecked Sendable {
        let prompt: String
        let width, height: Int
        let seed: Int64
        let batch: Int
        let sigmas: [Float]
        /// An edit's condition images, decoded, at the size they are encoded at.
        let references: [QwenPipeline.Reference]
        let initImage: QwenPipeline.InitImage?
        /// LoRAs, their paths resolved in the LoRA folder.
        var loras: [LoraRequest] = []

        /// nil and the reason when the engine cannot do it (yet). `vision`: the engine has the vision tower (edits).
        /// `loraDir`: the folder of the request's LoRAs (nil: LoRAs are refused).
        static func parse(_ body: Data, vision: Bool = true, loraDir: String? = nil) -> (ImageRequest?, String?) {
            guard let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
                return (nil, "the body is not a JSON object")
            }
            func array(_ key: String) -> [Any] { json[key] as? [Any] ?? [] }
            let refs = array("ref_images")
            if !refs.isEmpty && !vision {
                return (nil, "Qwen Image 2.1 editing requires Qwen3-VL vision weights; start the engine with --llm_vision")
            }
            // sd-server's `lora`: [{path, multiplier}], the path relative to `--lora-model-dir` and inside it.
            var loras: [LoraRequest] = []
            for (i, item) in array("lora").enumerated() {
                guard let dir = loraDir else { return (nil, "LoRAs need the LoRA folder: start the engine with --lora-model-dir") }
                guard let entry = item as? [String: Any], let path = entry["path"] as? String, !path.isEmpty else {
                    return (nil, "lora[\(i)] has no path")
                }
                let multiplier = (entry["multiplier"] as? NSNumber)?.floatValue ?? 1
                let root = URL(fileURLWithPath: dir).standardizedFileURL.path
                let full = URL(fileURLWithPath: path, relativeTo: URL(fileURLWithPath: dir, isDirectory: true)).standardizedFileURL.path
                guard full.hasPrefix(root + "/"), FileManager.default.fileExists(atPath: full) else {
                    return (nil, "lora[\(i)]: \(path) is not a file in the LoRA folder")
                }
                guard multiplier.isFinite else { return (nil, "lora[\(i)]: multiplier \(multiplier)") }
                loras.append(LoraRequest(path: full, multiplier: multiplier))
            }
            if let hires = json["hires"] as? [String: Any], hires["enabled"] as? Bool == true {
                return (nil, "Kokon's Mac engine has no second pass (hires)")
            }
            if let format = json["output_format"] as? String, format != "png" { return (nil, "output_format \(format): png only") }
            let width = json["width"] as? Int ?? 1024, height = json["height"] as? Int ?? 1024
            guard width % 32 == 0, height % 32 == 0, width >= 64, height >= 64, width <= 4096, height <= 4096 else {
                return (nil, "\(width)×\(height): each side must be a multiple of 32 from 64 to 4096")
            }
            let sample = json["sample_params"] as? [String: Any] ?? [:]
            let cfg = (sample["guidance"] as? [String: Any])?["txt_cfg"] as? Double ?? 1
            guard abs(cfg - 1) < 1e-6 else { return (nil, "txt_cfg \(cfg): Kokon's Mac engine runs at CFG 1 only") }
            var sigmas = (sample["custom_sigmas"] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.floatValue }
            let steps = sample["sample_steps"] as? Int ?? QwenPipeline.turboSigmas.count - 1
            if sigmas.isEmpty {
                guard steps == QwenPipeline.turboSigmas.count - 1 else {
                    return (nil, "\(steps) steps without custom_sigmas: the engine knows Turbo's 8-step schedule only")
                }
                sigmas = QwenPipeline.turboSigmas
            }
            guard sigmas.count >= 2, sigmas.allSatisfy({ $0 >= 0 && $0 <= 1 }) else { return (nil, "custom_sigmas \(sigmas) out of [0, 1]") }
            var seed = (json["seed"] as? NSNumber)?.int64Value ?? 42
            if seed < 0 { seed = Int64.random(in: 0..<(1 << 31)) }
            let batch = json["batch_count"] as? Int ?? 1
            guard (1...EngineServer.maxBatch).contains(batch) else { return (nil, "batch_count \(batch): 1 to \(EngineServer.maxBatch)") }
            // ref_image_args: sd.cpp's key=value list; only resize_before_vae changes what the engine does.
            var resize = true
            for pair in (json["ref_image_args"] as? String ?? "").split(separator: ",") {
                let kv = pair.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                if kv.count == 2, kv[0] == "resize_before_vae" { resize = !["false", "0", "no", "off"].contains(kv[1].lowercased()) }
            }
            var references: [QwenPipeline.Reference] = []
            for (i, item) in refs.enumerated() {
                guard let text = item as? String, let data = Data(base64Encoded: String(text.split(separator: ",").last ?? ""),
                                                                   options: .ignoreUnknownCharacters),
                      let image = try? QwenPipeline.decodeImage(data) else {
                    return (nil, "ref_images[\(i)] is not a base64 image")
                }
                var r = QwenPipeline.Reference(rgba: image.rgba, width: image.width, height: image.height)
                if resize { r = EngineServer.resizeToTarget(r, width: width, height: height) }
                guard r.width % 32 == 0, r.height % 32 == 0 else {
                    return (nil, "Qwen Image 2.1 reference dimensions must be multiples of 32 (\(r.width)×\(r.height))")
                }
                references.append(r)
            }
            // init_image, mask_image and strength (sd-server's default 0.75), at the output's size as Kokon sends them
            // (`image_preprocess` mode=none).
            func decoded(_ key: String) -> Data? {
                (json[key] as? String).flatMap { Data(base64Encoded: String($0.split(separator: ",").last ?? ""), options: .ignoreUnknownCharacters) }
            }
            var initImage: QwenPipeline.InitImage?
            if json["init_image"] is String || json["mask_image"] is String {
                guard let data = decoded("init_image"), let image = try? QwenPipeline.decodeImage(data) else {
                    return (nil, json["init_image"] is String ? "init_image is not a base64 image" : "a mask_image needs an init_image")
                }
                guard image.width == width, image.height == height else {
                    return (nil, "init_image is \(image.width)×\(image.height); Kokon's Mac engine needs it at the output's \(width)×\(height)")
                }
                var mask: [UInt8]?
                if json["mask_image"] is String {
                    guard let data = decoded("mask_image"), let m = try? QwenPipeline.decodeGray(data) else {
                        return (nil, "mask_image is not a base64 image")
                    }
                    guard m.width == width, m.height == height else {
                        return (nil, "mask_image is \(m.width)×\(m.height); Kokon's Mac engine needs it at the output's \(width)×\(height)")
                    }
                    mask = m.gray
                }
                let strength = (json["strength"] as? NSNumber)?.floatValue ?? 0.75
                guard strength.isFinite, strength >= 0, strength <= 1 else { return (nil, "strength \(strength) out of [0, 1]") }
                initImage = .init(image: .init(rgba: image.rgba, width: width, height: height), mask: mask, strength: strength)
            }
            var request = ImageRequest(prompt: json["prompt"] as? String ?? "", width: width, height: height, seed: seed,
                                       batch: batch, sigmas: sigmas, references: references, initImage: initImage)
            request.loras = loras
            return (request, nil)
        }
    }

    /// sd.cpp's `resize_before_vae` for Qwen-Image 2.1 (pipeline/image.cpp): the reference resized to the output's area
    /// at its own aspect, each side rounded to 32, nearest neighbour (`sd::ops::interpolate`'s default); the vision
    /// tower then sees the same image (`vlm_use_vae_input`).
    static func resizeToTarget(_ r: QwenPipeline.Reference, width: Int, height: Int) -> QwenPipeline.Reference {
        let area = Double(width * height)
        let w = (area * Double(r.width) / Double(r.height)).squareRoot()
        let h = w * Double(r.height) / Double(r.width)
        let (ow, oh) = (Int((w / 32).rounded() * 32), Int((h / 32).rounded() * 32))
        guard ow > 0, oh > 0, (ow, oh) != (r.width, r.height) else { return r }
        return resize(r, width: ow, height: oh)
    }

    static let maxBatch = 4, maxQueue = 8
    public let paths: Paths
    let pipeline: QwenPipeline
    private var jobs: [String: Job] = [:]
    private var queue: [Job] = []
    private var running: Job?
    private let lock = NSLock()
    private let wake = DispatchSemaphore(value: 0)
    /// Held by a running image or text generation: one GPU user at a time.
    private let gpu = NSLock()
    /// Lines to stdout (qls-core reads them from the log file it redirects stdout to).
    public var log: @Sendable (String) -> Void = { line in
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }

    public init(paths: Paths) throws {
        self.paths = paths
        for path in [paths.diffusionModel, paths.vae, paths.textEncoder] where !FileManager.default.fileExists(atPath: path) {
            throw GGUFFile.Failure.open(path)
        }
        if let vision = paths.vision, !FileManager.default.fileExists(atPath: vision) { throw GGUFFile.Failure.open(vision) }
        pipeline = try QwenPipeline(encoder: paths.textEncoder, dit: paths.diffusionModel, vae: paths.vae)
        pipeline.visionPath = paths.vision
        pipeline.keepModels = true
        pipeline.log = { _ in }
        let worker = Thread { [self] in work() }
        worker.name = "kokon.jobs"
        worker.qualityOfService = .userInitiated
        worker.start()
    }

    // MARK: - HTTP

    public func handle(_ request: HTTPServer.Request) -> HTTPServer.Response {
        let parts = request.path.split(separator: "/").map(String.init)
        guard parts.count >= 3, parts[0] == "sdcpp", parts[1] == "v1" else { return .error(404, "not found: \(request.path)") }
        switch (request.method, Array(parts.dropFirst(2))) {
        case ("GET", ["capabilities"]): return .json(200, capabilities())
        case ("POST", ["img_gen"]): return submit(request.body)
        case ("GET", let p) where p.count == 2 && p[0] == "jobs":
            return lock.withLock { jobs[p[1]].map { .json(200, describe($0)) } ?? .error(404, "unknown job \(p[1])") }
        case ("POST", let p) where p.count == 3 && p[0] == "jobs" && p[2] == "cancel": return cancel(p[1])
        case ("POST", ["text_gen"]): return textGen(request.body)
        case (_, ["upscale"]):
            return .error(404, "Kokon's Mac engine has no \(parts[2]) endpoint yet")
        default: return .error(404, "not found: \(request.method) \(request.path)")
        }
    }

    func capabilities() -> [String: Any] {
        let url = URL(fileURLWithPath: paths.diffusionModel)
        let feature: [String: Any] = ["ref_images": paths.vision != nil, "init_image": true, "mask_image": true, "lora": paths.loraDir != nil,
                                      "hires": false, "custom_sigmas": true, "cancel_generating": true]
        return [
            "engine": "kokon-engine-mac",
            "model": ["name": url.lastPathComponent, "stem": url.deletingPathExtension().lastPathComponent, "path": paths.diffusionModel],
            "supported_modes": ["img_gen"],
            "samplers": ["euler"],
            "schedulers": [String](),
            "output_formats": ["png"],
            "limits": ["min_width": 64, "max_width": 4096, "min_height": 64, "max_height": 4096,
                       "max_batch_count": EngineServer.maxBatch, "max_queue_size": EngineServer.maxQueue,
                       "max_text_tokens": EngineServer.maxTextTokens, "max_text_images": paths.vision != nil ? EngineServer.maxTextImages : 0],
            "features_by_mode": ["img_gen": feature],
            "defaults_by_mode": ["img_gen": ["sample_steps": QwenPipeline.turboSigmas.count - 1, "txt_cfg": 1]],
            "upscalers": [Any](),
            "upscale": false,
            "text_generation": true,
        ]
    }

    func submit(_ body: Data) -> HTTPServer.Response {
        let (parsed, reason) = ImageRequest.parse(body, vision: paths.vision != nil, loraDir: paths.loraDir)
        guard let parsed else { return .error(400, reason ?? "bad request") }
        return lock.withLock {
            guard queue.count < EngineServer.maxQueue else { return .error(429, "the queue is full") }
            let job = Job(id: UUID().uuidString.lowercased(), request: parsed)
            jobs[job.id] = job
            queue.append(job)
            wake.signal()
            return .json(202, ["id": job.id, "kind": "img_gen", "status": job.status, "created": job.created,
                               "poll_url": "/sdcpp/v1/jobs/\(job.id)"])
        }
    }

    /// A queued job leaves the queue; a running one is marked and stops at the next DiT layer, its result dropped.
    func cancel(_ id: String) -> HTTPServer.Response {
        lock.withLock {
            guard let job = jobs[id] else { return .error(404, "unknown job \(id)") }
            if job.status == "queued" || job.status == "generating" {
                queue.removeAll { $0 === job }
                job.status = "cancelled"
                job.completed = Int(Date().timeIntervalSince1970)
            }
            return .json(200, describe(job))
        }
    }

    /// sd-server's job object. Called with the lock held.
    func describe(_ job: Job) -> [String: Any] {
        var out: [String: Any] = ["id": job.id, "kind": "img_gen", "status": job.status, "created": job.created,
                                  "queue_position": queue.firstIndex { $0 === job }.map { $0 + 1 } ?? 0]
        if let s = job.started { out["started"] = s }
        if let c = job.completed { out["completed"] = c }
        if job.status == "completed" {
            out["result"] = ["output_format": "png",
                             "images": job.images.enumerated().map { ["index": $0.offset, "b64_json": $0.element] as [String: Any] }]
        }
        if let e = job.error { out["error"] = ["code": e.code, "message": e.message] }
        return out
    }

    // MARK: - text generation (Prompt+)

    /// The fields of `text_gen` (sd-server's names and checks, `examples/server/routes_sdcpp.cpp`).
    struct TextRequest: @unchecked Sendable {
        let system, prompt: String
        /// Shown before the prompt, sides rounded to 32 as sd.cpp's `vision_size`.
        let images: [QwenPipeline.Reference]
        let maxTokens: Int
        let sampling: TextSampler.Parameters
        let seed: Int64
        let stream: Bool

        static func parse(_ body: Data, vision: Bool = true) -> (TextRequest?, String?) {
            guard let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return (nil, "body must be an object") }
            guard let prompt = json["prompt"] as? String, !prompt.isEmpty else { return (nil, "prompt is required") }
            guard let system = json["system_prompt"] as? String else {
                return (nil, "system_prompt is required (an empty string means no system prompt)")
            }
            let maxTokens = json["max_tokens"] as? Int ?? 512
            guard (1...EngineServer.maxTextTokens).contains(maxTokens) else { return (nil, "max_tokens must be between 1 and \(EngineServer.maxTextTokens)") }
            var images: [QwenPipeline.Reference] = []
            if let list = json["images"] {
                guard let list = list as? [Any], list.count <= EngineServer.maxTextImages else {
                    return (nil, "images must be an array of at most \(EngineServer.maxTextImages) base64 images")
                }
                if !list.isEmpty && !vision { return (nil, "images need the Qwen3-VL vision weights (--llm_vision)") }
                for (i, item) in list.enumerated() {
                    guard let text = item as? String, let data = Data(base64Encoded: String(text.split(separator: ",").last ?? ""),
                                                                       options: .ignoreUnknownCharacters),
                          let image = try? QwenPipeline.decodeImage(data) else {
                        return (nil, "images[\(i)] is not a base64 image")
                    }
                    images.append(EngineServer.roundedTo32(.init(rgba: image.rgba, width: image.width, height: image.height)))
                }
            }
            var sampling = TextSampler.Parameters(temperature: 0, topP: 1, topK: 0, presencePenalty: 0)
            var seed: Int64 = -1
            if let s = json["sampling"] {
                guard let s = s as? [String: Any] else { return (nil, "sampling must be an object") }
                func number(_ key: String) -> Double? { (s[key] as? NSNumber)?.doubleValue }
                sampling.temperature = Float(number("temperature") ?? 0)
                sampling.topP = Float(number("top_p") ?? 1)
                sampling.topK = Int(number("top_k") ?? 0)
                sampling.presencePenalty = Float(number("presence_penalty") ?? 0)
                seed = (s["seed"] as? NSNumber)?.int64Value ?? -1
                guard sampling.temperature.isFinite, sampling.temperature >= 0, sampling.topP.isFinite, sampling.topP > 0, sampling.topP <= 1,
                      sampling.topK >= 0, sampling.presencePenalty.isFinite else {
                    return (nil, "sampling needs temperature >= 0, 0 < top_p <= 1, top_k >= 0 and a finite presence_penalty")
                }
            }
            return (TextRequest(system: system, prompt: prompt, images: images, maxTokens: maxTokens, sampling: sampling, seed: seed,
                                stream: json["stream"] as? Bool ?? true), nil)
        }
    }

    static let maxTextTokens = 4096, maxTextImages = 4

    /// sd.cpp's `vision_size` for text generation (no `image_max_pixels`): each side rounded to a multiple of 32, the
    /// image resized when that changes it (nearest neighbour, as the edit references).
    static func roundedTo32(_ r: QwenPipeline.Reference) -> QwenPipeline.Reference {
        let (w, h) = (max(32, Int((Double(r.width) / 32).rounded()) * 32), max(32, Int((Double(r.height) / 32).rounded()) * 32))
        return (w, h) == (r.width, r.height) ? r : resize(r, width: w, height: h)
    }

    /// Nearest-neighbour resize of 8-bit RGBA (`sd::ops::interpolate`'s default mode).
    static func resize(_ r: QwenPipeline.Reference, width ow: Int, height oh: Int) -> QwenPipeline.Reference {
        var out = [UInt8](repeating: 0, count: ow * oh * 4)
        for y in 0..<oh {
            let sy = min(r.height - 1, y * r.height / oh)
            for x in 0..<ow {
                let sx = min(r.width - 1, x * r.width / ow)
                for c in 0..<4 { out[(y * ow + x) * 4 + c] = r.rgba[(sy * r.width + sx) * 4 + c] }
            }
        }
        return QwenPipeline.Reference(rgba: out, width: ow, height: oh)
    }

    /// Synchronous like sd-server's: it waits for a running image (one GPU user at a time) and holds the models while it
    /// writes. Streamed (the default) as Server-Sent Events: `delta` {text} per piece, then `done` {text, finish_reason,
    /// seed, usage, timings} or `error` {error}; closing the connection stops it.
    func textGen(_ body: Data) -> HTTPServer.Response {
        let (parsed, reason) = TextRequest.parse(body, vision: paths.vision != nil)
        guard let request = parsed else { return .error(400, reason ?? "bad request") }
        guard request.stream else {
            let outcome = Result { try gpu.withLock { try generateText(request) { _ in true } } }
            switch outcome {
            case .success(let result): return .json(200, EngineServer.done(result))
            case .failure(let error):
                log("[ERROR  ] engine-mac - text generation failed: \(error)")
                return .error(500, "text generation failed")
            }
        }
        return .streaming(contentType: "text/event-stream") { [self] write in
            // Before waiting for a running image, so the client gets the headers at once.
            guard write(Data(": waiting for the model\n\n".utf8)) else { return }
            func event(_ name: String, _ object: Any) -> Bool {
                let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
                return write(Data("event: \(name)\ndata: ".utf8) + data + Data("\n\n".utf8))
            }
            let outcome = Result { try gpu.withLock { try generateText(request) { piece in event("delta", ["text": piece]) } } }
            switch outcome {
            case .success(let result): _ = event("done", EngineServer.done(result))
            case .failure(let error):
                log("[ERROR  ] engine-mac - text generation failed: \(error)")
                _ = event("error", ["error": "text generation failed"])
            }
        }
    }

    private func generateText(_ r: TextRequest, onPiece: (String) -> Bool) throws -> QwenTextGenerator.Result {
        let result = try pipeline.generateText(system: r.system, prompt: r.prompt, images: r.images, maxTokens: r.maxTokens,
                                               sampling: r.sampling, seed: r.seed, onPiece: onPiece)
        log(String(format: "[INFO   ] engine-mac - text generation: %d image(s) in %.2fs, %d prompt tokens, %d generated in %.2fs (prefill %.2fs, %.1f tok/s), seed %lld",
                   r.images.count, result.image, result.promptTokens, result.generatedTokens,
                   result.image + result.prepare + result.prefill + result.decode, result.prefill,
                   result.decode > 0 ? Double(result.tokens.count - 1) / result.decode : 0, result.seed))
        return result
    }

    /// sd-server's `done` object.
    static func done(_ r: QwenTextGenerator.Result) -> [String: Any] {
        ["text": r.text, "finish_reason": r.finish.rawValue, "seed": r.seed,
         "usage": ["prompt_tokens": r.promptTokens, "completion_tokens": r.generatedTokens],
         "timings": ["prepare_s": r.prepare, "image_s": r.image, "prefill_s": r.prefill, "decode_s": r.decode]]
    }

    // MARK: - the jobs

    private func work() {
        while true {
            wake.wait()
            guard let job: Job = lock.withLock({
                guard !queue.isEmpty else { return nil }
                let job = queue.removeFirst()
                job.status = "generating"
                job.started = Int(Date().timeIntervalSince1970)
                running = job
                return job
            }) else { continue }
            let outcome: Result<[String], Error> = autoreleasepool { Result { try gpu.withLock { try generate(job) } } }
            lock.withLock {
                running = nil
                job.completed = Int(Date().timeIntervalSince1970)
                guard job.status != "cancelled" else { return }
                switch outcome {
                case .success(let images):
                    job.images = images
                    job.status = "completed"
                case .failure(let error):
                    job.status = "failed"
                    job.error = ("generation_failed", "\(error)")
                }
            }
            if case .failure(let error) = outcome, !(error is QwenDiT.Cancelled) { log("[ERROR  ] engine: \(error)") }
            // Older finished jobs are forgotten (the client fetched their result long ago).
            lock.withLock {
                let finished = jobs.values.filter { $0.completed != nil }.sorted { $0.created < $1.created }
                for old in finished.dropLast(16) { jobs[old.id] = nil }
            }
        }
    }

    private func generate(_ job: Job) throws -> [String] {
        let r = job.request
        let started = DispatchTime.now().uptimeNanoseconds
        func seconds(since t: UInt64) -> Double { Double(DispatchTime.now().uptimeNanoseconds - t) * 1e-9 }
        log("[INFO   ] engine-mac - generate_image \(r.width)x\(r.height)")
        if !r.references.isEmpty {
            log("[INFO   ] engine-mac - EDIT mode: \(r.references.map { "\($0.width)x\($0.height)" }.joined(separator: ", "))")
        }
        log("[INFO   ] engine-mac - sampling using Euler method")
        pipeline.cancelled = { [weak self, job] in self?.lock.withLock { job.status == "cancelled" } ?? true }
        var images: [String] = []
        for i in 0..<r.batch {
            let seed = r.seed + Int64(i)
            var stepStart = DispatchTime.now().uptimeNanoseconds
            pipeline.events = { [self] event in
                switch event {
                case .encoded(let tokens, let s):
                    log(String(format: "[INFO   ] engine-mac - get_learned_condition completed, %d tokens, taking %.2fs", tokens, s))
                    log("[INFO   ] engine-mac - generating image: \(i + 1)/\(r.batch) - seed \(seed)")
                    stepStart = DispatchTime.now().uptimeNanoseconds
                case .step(let step, let total, let s):
                    let filled = 50 * step / total
                    let bar = String(repeating: "=", count: max(0, filled - 1)) + (filled < 50 ? ">" : "=")
                        + String(repeating: " ", count: 50 - filled)
                    log(String(format: "  |%@| %d/%d - %.2fs/it", bar, step, total, s))
                case .decoding:
                    let m = MemoryUsage.now()
                    log(String(format: "[INFO   ] engine-mac - sampling completed, taking %.2fs (footprint %.2f GB)", seconds(since: stepStart), m.footprint))
                    log("[INFO   ] engine-mac - decoding 1 latents")
                }
            }
            let image = try pipeline.generate(prompt: r.prompt, references: r.references, initImage: r.initImage, width: r.width, height: r.height,
                                              seed: UInt64(bitPattern: seed), sigmas: r.sigmas, loras: r.loras)
            if i == 0, let set = pipeline.loraSet {
                log("[INFO   ] engine-mac - LoRAs: \(set.applied) module(s) applied"
                    + (set.unmatched.isEmpty ? "" : ", \(set.unmatched.count) not in this model (\(set.unmatched.prefix(3).joined(separator: ", ")))"))
            }
            let png = try QwenPipeline.pngData(QwenPipeline.pixels(image, width: r.width, height: r.height), width: r.width, height: r.height)
            images.append(png.base64EncodedString())
            let t = pipeline.timings
            log(String(format: "[INFO   ] engine-mac - image %d/%d: vision %.2fs, text encoder %.2fs, VAE encoder %.2fs, DiT ready %.2fs, VAE %.2fs, total %.2fs",
                       i + 1, r.batch, t["vision"] ?? 0, t["encode"] ?? 0, t["vae encode"] ?? 0, t["dit load"] ?? 0, t["vae"] ?? 0, t["total"] ?? 0))
        }
        pipeline.events = nil
        let memory = MemoryUsage.now()
        log(String(format: "[INFO   ] engine-mac - memory: footprint %.2f GB (peak %.2f GB), resident %.2f GB (peak %.2f GB)",
                   memory.footprint, memory.footprintPeak, memory.resident, memory.residentPeak))
        log(String(format: "[INFO   ] engine-mac - generate_image completed in %.2fs", seconds(since: started)))
        return images
    }
}

/// This process's memory, GB: the footprint (what macOS charges it: anonymous and wired memory, not the file pages it
/// can drop) and the resident size (with the mapped model pages in use), now and at their peak.
public struct MemoryUsage {
    public let footprint, footprintPeak, resident, residentPeak: Double

    public static func now() -> MemoryUsage {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        guard result == KERN_SUCCESS else { return MemoryUsage(footprint: 0, footprintPeak: 0, resident: 0, residentPeak: 0) }
        let gb = 1.0 / Double(1 << 30)
        return MemoryUsage(footprint: Double(info.phys_footprint) * gb, footprintPeak: Double(info.ledger_phys_footprint_peak) * gb,
                           resident: Double(info.resident_size) * gb, residentPeak: Double(info.resident_size_peak) * gb)
    }
}

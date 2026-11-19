import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bestDownloaded, errorResult, handlers, label, MODEL_INFO, schemas, TASK_PICKS, taskOf, toErrorResult } from "../src/tools";
import { INSTRUCTIONS } from "../src/guide";

const obj = <K extends keyof typeof schemas>(k: K) => z.object(schemas[k]);

describe("input validation", () => {
  it("prompt is required and trimmed", () => {
    expect(obj("generate_image").safeParse({ prompt: "  " }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: " a fox " }).data?.prompt).toBe("a fox");
  });
  it("dimensions, aspect, quality, seed", () => {
    expect(obj("generate_image").safeParse({ prompt: "x", width: 32, height: 512 }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", width: 5000, height: 512 }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", aspect_ratio: "16:9" }).success).toBe(true);
    expect(obj("generate_image").safeParse({ prompt: "x", aspect_ratio: "wide" }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", quality: "quality" }).success).toBe(true);
    expect(obj("generate_image").safeParse({ prompt: "x", quality: "ultra" }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", quality: "max" }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", seed: -2 }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", reference_images: ["a.png", "b.png"] }).data?.reference_images).toEqual(["a.png", "b.png"]);
    expect(obj("generate_image").safeParse({ prompt: "x", reference_images: Array(11).fill("a.png") }).success).toBe(false);
  });
  it("edit tools warn against reusing the source's seed", () => {
    for (const k of ["edit_image", "edit_images", "inpaint_image", "outpaint_image"] as const) {
      // As clients see it: the JSON Schema of the tool's input.
      const seed = (z.toJSONSchema(obj(k)) as { properties: Record<string, { description?: string }> }).properties.seed;
      expect(seed.description).toMatch(/Never reuse the seed the source image was generated with/);
    }
    const gen = (z.toJSONSchema(obj("generate_image")) as { properties: Record<string, { description?: string }> }).properties.seed;
    expect(gen.description).toMatch(/^Seed for reproducible results/);
    expect(gen.description).not.toMatch(/source image/);
  });
  it("edit_images limits and order", () => {
    expect(obj("edit_images").safeParse({ prompt: "x", image_paths: [] }).success).toBe(false);
    expect(obj("edit_images").safeParse({ prompt: "x", image_paths: Array(11).fill("a.png") }).success).toBe(false);
    expect(obj("edit_images").safeParse({ prompt: "x", image_paths: ["b.png", "a.png"] }).data?.image_paths).toEqual(["b.png", "a.png"]);
  });
  it("outpaint defaults", () => {
    const r = obj("outpaint_image").parse({ image_path: "a.png", prompt: "x", left: 256 });
    expect(r).toMatchObject({ left: 256, right: 0, top: 0, bottom: 0, units: "pixels" });
  });
  it("sends the caller's prompt as written: Kokon's Prompt+ never runs for MCP", async () => {
    const sent: Record<string, unknown>[] = [];
    const client = {
      call: async (method: string, _path: string, body?: Record<string, unknown>) => {
        if (method === "POST" && body) sent.push(body);
        return { id: "j", status: "failed", error: { code: "x", message: "stop here" }, results: [], notes: [], queue_position: 0, plan: null, stage: null, step: null };
      },
    };
    const ctx = { client: client as never, cwd: process.cwd(), progress: () => {} };
    await handlers.generate_image({ prompt: "A watercolour fox in snow." } as never, ctx);
    await handlers.generate_image({ prompt: "x", enhance: true } as never, ctx);
    expect(sent.map((b) => [b.prompt, b.enhance, b.mode])).toEqual([
      ["A watercolour fox in snow.", false, "generate"],
      ["x", false, "generate"],
    ]);
  });
  it("an output in a QLS_MCP_ALLOWED_DIRS folder is sent with that folder as the workspace (#39)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qls-mcp-ws-"));
    const [proj, extra] = [path.join(tmp, "proj"), path.join(tmp, "thumbs")];
    fs.mkdirSync(proj);
    fs.mkdirSync(extra);
    const sent: Record<string, unknown>[] = [];
    const client = {
      call: async (method: string, p: string, body?: Record<string, unknown>) => {
        if (p === "/config") return { outputDir: path.join(tmp, "out") };
        if (method === "POST" && body) sent.push(body);
        return { id: "j", status: "failed", error: { code: "x", message: "stop here" }, results: [], notes: [], queue_position: 0, plan: null, stage: null, step: null };
      },
    };
    const ctx = { client: client as never, cwd: proj, progress: () => {} };
    const before = process.env.QLS_MCP_ALLOWED_DIRS;
    process.env.QLS_MCP_ALLOWED_DIRS = extra;
    try {
      await handlers.generate_image({ prompt: "x", output_path: path.join(extra, "Upscaled", "a.png") } as never, ctx);
      await handlers.generate_image({ prompt: "x", output_path: "a.png" } as never, ctx);
      await handlers.generate_image({ prompt: "x" } as never, ctx);
    } finally {
      if (before === undefined) delete process.env.QLS_MCP_ALLOWED_DIRS;
      else process.env.QLS_MCP_ALLOWED_DIRS = before;
    }
    expect(sent.map((b) => b.workspace)).toEqual([extra, proj, proj]);
  });
  it("width without height is rejected before any service call", async () => {
    const ctx = { client: {} as never, cwd: process.cwd(), progress: () => {} };
    const res = await handlers.generate_image({ prompt: "x", width: 512 } as never, ctx).catch(toErrorResult);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/both width and height/);
  });
});

describe("fork tools", () => {
  const job = { id: "j", status: "failed", error: { code: "x", message: "stop here" }, results: [], notes: [], queue_position: 0, plan: null, stage: null, step: null };
  const fake = (extra: (method: string, p: string, body?: Record<string, unknown>) => unknown = () => undefined) => {
    const sent: Record<string, unknown>[] = [];
    const calls: [string, string, unknown][] = [];
    const client = {
      call: async (method: string, p: string, body?: Record<string, unknown>) => {
        calls.push([method, p, body]);
        const r = extra(method, p, body);
        if (r !== undefined) return r;
        if (method === "POST" && p === "/jobs" && body) sent.push(body);
        return job;
      },
    };
    return { sent, calls, ctx: { client: client as never, cwd: process.cwd(), progress: () => {} } };
  };
  const area = { x: 0.1, y: 0.2, w: 0.3, h: 0.4, text: "a red car" };

  it("validates areas", () => {
    expect(obj("generate_image").safeParse({ prompt: "x", layout: [area] }).success).toBe(true);
    expect(obj("generate_image").safeParse({ prompt: "x", layout: [{ ...area, x: 1.2 }] }).success).toBe(false);
    expect(obj("generate_image").safeParse({ prompt: "x", layout: [{ ...area, text: " " }] }).success).toBe(false);
    expect(obj("inpaint_image").safeParse({ image_path: "a.png", areas: [{ ...area, points: [[0.1, 0.2], [0.4, 0.2], [0.3, 0.6]] }] }).success).toBe(true);
    expect(obj("inpaint_image").safeParse({ image_path: "a.png", areas: [{ ...area, points: [[0.1, 0.2]] }] }).success).toBe(false);
  });

  it("sends the layout and LoRAs with a new image, not the layout with references", async () => {
    const f = fake();
    await handlers.generate_image({ prompt: "a street", layout: [area], loras: ["l1"] } as never, f.ctx);
    expect(f.sent[0]).toMatchObject({ mode: "generate", layout: [area], loras: ["l1"] });
  });

  it("inpaints areas without a mask, and needs one of the two", async () => {
    const tmp = fs.mkdtempSync(path.join(process.cwd(), ".qls-mcp-t-"));
    try {
      fs.writeFileSync(path.join(tmp, "a.png"), "x");
      const f = fake();
      await handlers.inpaint_image({ image_path: path.join(tmp, "a.png"), action: "edit", prompt: "", areas: [area] } as never, f.ctx);
      expect(f.sent[0]).toMatchObject({ mode: "inpaint", mask: null, regions: [area] });
      const res = await handlers.inpaint_image({ image_path: path.join(tmp, "a.png"), action: "edit", prompt: "x" } as never, f.ctx).catch(toErrorResult);
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/mask_path or areas/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  const status = {
    profile: { id: "qwen-image-2.1", model: "qwen-image-2.1" },
    profiles: [
      { id: "qwen-image-2.1", display_name: "Qwen", model: "qwen-image-2.1", installed: true },
      { id: "krea-2-turbo", display_name: "Krea 2 Turbo", model: "krea-2", installed: true },
      { id: "flux-3-image-klein", display_name: "FLUX.3", model: "flux-3", installed: false },
    ],
  };

  it("lists the models with the one in use", async () => {
    const f = fake((_m, p) => (p === "/status" ? status : undefined));
    const r = await handlers.list_models({} as never, f.ctx);
    expect(r.structured).toMatchObject({ active_model: "qwen-image-2.1" });
    expect((r.structured as { models: { id: string; downloaded: boolean }[] }).models.map((m) => [m.id, m.downloaded])).toEqual([
      ["qwen-image-2.1", true],
      ["krea-2-turbo", true],
      ["flux-3-image-klein", false],
    ]);
    expect(r.text).toContain("* qwen-image-2.1:");
  });

  it("selects a downloaded model, downloads only when asked", async () => {
    const f = fake((_m, p) => (p === "/status" ? status : p === "/setup/hardware" ? { current: "nvidia-16" } : {}));
    await handlers.select_model({ model_id: "krea-2-turbo" } as never, f.ctx);
    expect(f.calls).toContainEqual(["POST", "/models/use", { profile: "krea-2-turbo" }]);
    const no = await handlers.select_model({ model_id: "flux-3-image-klein" } as never, f.ctx);
    expect(no.isError).toBe(true);
    expect(f.calls.some(([, p]) => p === "/setup/install")).toBe(false);
    await handlers.select_model({ model_id: "flux-3-image-klein", download: true } as never, f.ctx);
    expect(f.calls).toContainEqual(["POST", "/setup/install", { preset: "nvidia-16", target: "flux-3-image-klein", apply: true }]);
    const bad = await handlers.select_model({ model_id: "nope" } as never, f.ctx).catch(toErrorResult);
    expect(bad.isError).toBe(true);
  });

  it("lists the LoRAs of the model in use", async () => {
    const f = fake((_m, p) =>
      p === "/status" ? status : p === "/loras" ? { items: [{ id: "a", name: "Ink", model: "", triggerWords: "ink style", steps: 4, cfgScale: 1 }, { id: "b", name: "Film", model: "krea-2" }] } : undefined,
    );
    const r = await handlers.list_loras({} as never, f.ctx);
    expect(r.text).toContain("a: Ink (trigger: ink style) (sets 4 steps, CFG 1)");
    expect(r.text).not.toContain("Film");
  });
});

describe("upscale_image", () => {
  it("validates factor and size", () => {
    expect(obj("upscale_image").safeParse({ image_path: "a.png" }).success).toBe(true);
    expect(obj("upscale_image").safeParse({ image_path: "a.png", scale: 1 }).success).toBe(false);
    expect(obj("upscale_image").safeParse({ image_path: "a.png", width: 9000 }).success).toBe(false);
  });
  it("scale and width together are rejected before any service call", async () => {
    const ctx = { client: {} as never, cwd: process.cwd(), progress: () => {} };
    const res = await handlers.upscale_image({ image_path: "a.png", scale: 2, width: 4000 } as never, ctx).catch(toErrorResult);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/either scale or width/);
  });
});

describe("progress labels are truthful", () => {
  const j = { id: "j", status: "running", stage: "generating", step: [3, 30] as [number, number], queue_position: 0, plan: null, results: [], error: null, notes: [] };
  it("only shows steps when reported", () => {
    expect(label(j)).toBe("Generating step 3/30");
    expect(label({ ...j, step: null })).toBe("Generating");
    expect(label({ ...j, status: "starting_backend" })).toBe("Loading the model");
    expect(label({ ...j, stage: "upscaling", step: null })).toBe("Upscaling");
    expect(label({ ...j, stage: "refining", step: [2, 6] })).toBe("Refining step 2/6");
  });
});

describe("model guide", () => {
  const profiles = [
    { id: "qwen-image-2.1", installed: false },
    { id: "krea-2-turbo", installed: true },
    { id: "flux-3-image-klein", installed: true },
    { id: "fibo-2.0-edit-turbo", installed: true },
  ];
  it("knows the task of each job", () => {
    expect(taskOf({ mode: "generate" })).toBe("new_image");
    expect(taskOf({ mode: "generate", layout: [{}] })).toBe("layout");
    expect(taskOf({ mode: "compose" })).toBe("combine");
    expect(taskOf({ mode: "inpaint", inpaint_action: "remove" })).toBe("remove");
    expect(taskOf({ mode: "inpaint", inpaint_action: "edit" })).toBe("change_part");
    expect(taskOf({ mode: "upscale" })).toBeNull();
  });
  it("picks the best downloaded model per task", () => {
    expect(bestDownloaded("edit", profiles)).toBe("flux-3-image-klein");
    expect(bestDownloaded("new_image", profiles)).toBe("krea-2-turbo");
    expect(bestDownloaded("layout", profiles)).toBe("flux-3-image-klein");
    expect(bestDownloaded("edit", [{ id: "krea-2-turbo", installed: true }])).toBeNull();
    // Every pick is a model that can do the task.
    for (const [t, ids] of Object.entries(TASK_PICKS)) for (const id of ids) expect(MODEL_INFO[id].tasks).toContain(t);
  });
  it("stops a job the model in use cannot do and names the model to switch to", async () => {
    let posted = false;
    const client = {
      call: async (method: string, p: string) => {
        if (p === "/status") return { profile: { id: "krea-2-turbo" }, profiles };
        if (method === "POST") posted = true;
        return {};
      },
    };
    const tmp = fs.mkdtempSync(path.join(process.cwd(), ".qls-mcp-g-"));
    try {
      fs.writeFileSync(path.join(tmp, "a.png"), "x");
      const r = await handlers.edit_image({ image_path: path.join(tmp, "a.png"), prompt: "make it night" } as never, { client: client as never, cwd: process.cwd(), progress: () => {} });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Krea 2 Turbo, the model in use, cannot edit a whole photo");
      expect(r.text).toContain('"flux-3-image-klein"');
      expect(posted).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("the instructions keep the model in use unless needed", () => {
    expect(INSTRUCTIONS).toMatch(/Otherwise keep the model in use/);
    expect(INSTRUCTIONS).toMatch(/Never download a model/);
  });
});

describe("error text", () => {
  it("carries the engine's reason, not only the message", () => {
    const r = errorResult("The inference server rejected the request.", "malformed_request", undefined, '{"error":"txt_cfg 4.0: Qwen-Image 2.1 Turbo runs at CFG 1 only"}');
    expect(r.text).toContain("runs at CFG 1 only");
    expect(errorResult("Cancelled.").text).toBe("Cancelled.");
  });
});

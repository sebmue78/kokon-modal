// The timing of a job's card in the stage: the live percentage, the prompt enhancer's text
// appearing word by word, and the prompt leaving for the percentage. Kept apart from Stage.tsx
// so the launch video (marketing/video) can drive the same card from its frame clock.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { jobPercent, type JobClock } from "../lib/logic";
import type { GenerationRequest, JobView } from "../lib/types";
import { reducedMotion } from "./Cocoon";

/** This machine's pace for the phases the plan cannot estimate (model load, prompt enhancer),
 * remembered between jobs; a per-viewer convenience, so defaults when storage is unavailable. */
const PROGRESS_KEY = "kokon.progress";
interface ProgressMemory { loadSeconds: number; enhancerSecondsPerWord: number }
function progressMemory(): ProgressMemory {
  const d: ProgressMemory = { loadSeconds: 20, enhancerSecondsPerWord: 0.015 };
  try {
    const v = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
    return { loadSeconds: v.loadSeconds > 0 ? v.loadSeconds : d.loadSeconds, enhancerSecondsPerWord: v.enhancerSecondsPerWord > 0 ? v.enhancerSecondsPerWord : d.enhancerSecondsPerWord };
  } catch {
    return d;
  }
}
function rememberProgress(m: Partial<ProgressMemory>) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ ...progressMemory(), ...m }));
  } catch {
    /* storage unavailable: the defaults stay */
  }
}

const ENHANCED_MODES = new Set(["generate", "compose", "edit", "multi_reference"]);

/** What a job's card has shown so far. The card unmounts while another version is on the stage,
 * so coming back continues from here instead of replaying the percentage and the prompt.
 * Times are `performance.now()`, valid for this page. */
export interface CardMemory {
  startedAt: number | null;
  runningAt: number | null;
  phase: { key: string; at: number };
  step: { key: string; at: number };
  target: number;
  value: number;
  /** Characters of the prompt revealed, and when the reveal started. */
  typed: number;
  typingFrom: number | null;
  /** When the whole prompt was on screen; the prompt's hold counts from here. */
  promptDoneAt: number | null;
  promptGone: boolean;
  progressShown: boolean;
  formStart: { at: number | null };
}

export function newCardMemory(now = performance.now()): CardMemory {
  return { startedAt: null, runningAt: null, phase: { key: "", at: now }, step: { key: "", at: now }, target: 0, value: 0, typed: 0, typingFrom: null, promptDoneAt: null, promptGone: false, progressShown: false, formStart: { at: null } };
}

/** Cards remembered by job id: the jobs in progress, a handful at most. */
const cards = new Map<string, CardMemory>();
const MAX_CARDS = 16;

/** The memory of job `id`'s main card, made on first use. */
export function cardMemory(id: string): CardMemory {
  let m = cards.get(id);
  if (!m) {
    m = newCardMemory();
    cards.set(id, m);
    // Oldest first: a job that never reported its end does not stay forever.
    for (const k of cards.keys()) {
      if (cards.size <= MAX_CARDS) break;
      cards.delete(k);
    }
  }
  return m;
}

export function forgetCard(id: string) {
  cards.delete(id);
}

/** Live percentage of a whole job (`jobPercent`), computed a few times a second, only ever going
 * up, and eased so it counts up smoothly. Tracks when the job and each phase started; `learn`
 * (the main card only) remembers how long the model load and the prompt enhancer took, and keeps
 * the card's clock and percentage in `cardMemory` so they continue after the card comes back. */
export function useJobPercent(job: JobView, request: GenerationRequest | null | undefined, learn = false): { pct: number; clock: JobClock } {
  const enhance = !!request?.enhance && ENHANCED_MODES.has(job.plan?.mode ?? request?.mode ?? "");
  const [card] = useState(() => (learn ? cardMemory(job.id) : newCardMemory()));
  const [shown, setShown] = useState<{ pct: number; clock: JobClock }>(() => ({ pct: card.value, clock: { elapsed: 0, inPhase: 0, inRunning: 0, sinceStep: 0, enhance, ...progressMemory() } }));
  const live = useRef({ job, enhance });
  live.current = { job, enhance };
  useEffect(() => {
    const mem = progressMemory();
    const c = card;
    const id = window.setInterval(() => {
      const { job: j, enhance: e } = live.current;
      const now = performance.now();
      if (c.startedAt === null && j.status !== "queued") c.startedAt = now;
      if (c.runningAt === null && j.status === "running") c.runningAt = now;
      const key = `${j.status}|${j.stage ?? ""}`;
      if (key !== c.phase.key) {
        // Learn the phases the plan does not estimate, when they end.
        const took = (now - c.phase.at) / 1000;
        const was = c.phase.key.split("|")[0];
        if (learn && was === "starting_backend" && took > 1) rememberProgress({ loadSeconds: took });
        if (learn && was === "enhancing_prompt" && j.enhanced_prompt) {
          const words = j.enhanced_prompt.split(/\s+/).filter(Boolean).length;
          if (words >= 5) rememberProgress({ enhancerSecondsPerWord: took / words });
        }
        c.phase = { key, at: now };
      }
      if (learn && (j.status === "done" || j.status === "failed" || j.status === "cancelled")) forgetCard(j.id);
      const stepKey = j.step ? `${j.stage}|${j.step[0]}/${j.step[1]}` : "";
      if (stepKey !== c.step.key) c.step = { key: stepKey, at: now };
      const clock: JobClock = {
        elapsed: c.startedAt === null ? 0 : (now - c.startedAt) / 1000,
        inPhase: (now - c.phase.at) / 1000,
        inRunning: c.runningAt === null ? 0 : (now - c.runningAt) / 1000,
        sinceStep: (now - c.step.at) / 1000,
        enhance: e,
        ...mem,
      };
      c.target = Math.max(c.target, jobPercent(j, clock));
      c.value += (c.target - c.value) * (reducedMotion() ? 1 : 0.18);
      if (c.target - c.value < 0.05) c.value = c.target;
      setShown({ pct: c.value, clock });
    }, 60);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return shown;
}

/** How long the finished prompt stays on screen before the percentage takes over (ms). */
export const PROMPT_HOLD_MS = 2200;
export const PROMPT_FADE_MS = 700;

/** Once the whole prompt is on screen it holds, then fades (`leaving`, styled by
 * `.prompt-stage.leaving`), then `onGone`. With `card`, the hold counts from when the prompt was
 * first complete, also on an earlier mount. `style` is for a clock other than the browser's. */
export function usePromptLeave(writing: boolean, text: string, onGone: () => void, card?: CardMemory): { leaving: boolean; style?: CSSProperties } {
  const [leaving, setLeaving] = useState(() => card?.promptDoneAt != null && performance.now() - card.promptDoneAt >= PROMPT_HOLD_MS);
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    if (writing || !text) return;
    const now = performance.now();
    if (card && card.promptDoneAt === null) card.promptDoneAt = now;
    const since = card?.promptDoneAt != null ? now - card.promptDoneAt : 0;
    const hold = window.setTimeout(() => setLeaving(true), Math.max(0, PROMPT_HOLD_MS - since));
    const end = window.setTimeout(() => gone.current(), Math.max(0, PROMPT_HOLD_MS + PROMPT_FADE_MS - since));
    return () => (window.clearTimeout(hold), window.clearTimeout(end));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writing, text]);
  return { leaving };
}

/** Inline style of the word starting at character `at` while `shown` characters are revealed;
 * none here, the CSS animation (`.prompt-text .w`) fades each word in when it mounts. */
export function wordStyle(_at: number, _shown: number): CSSProperties | undefined {
  return undefined;
}

/** Calm reading pace of the prompt (characters a second). */
const TYPE_CHARS_PER_S = 32;

/** Seconds the whole prompt takes to appear: ~32 characters a second, within 4-12 s (and half
 * the time a quick image takes). */
function typingSeconds(length: number, budget: number | null): number {
  const cap = Math.max(4, Math.min(12, budget ? budget * 0.5 : 12));
  return Math.min(cap, Math.max(4, length / TYPE_CHARS_PER_S));
}

/** Characters of `text` a card coming back at `now` shows at once: what it had revealed, or what
 * the reveal has reached meanwhile, whichever is more. */
export function revealedOnReturn(card: CardMemory, text: string, budget: number | null, now: number): number {
  if (card.typingFrom === null || !text) return Math.min(text.length, card.typed);
  const due = (text.length * (now - card.typingFrom)) / 1000 / typingSeconds(text.length, budget);
  return Math.min(text.length, Math.max(card.typed, due));
}

/** How many characters of `text` to show now: ~32 a second, faster when needed to finish in
 * 4-12 s (and in half the time a quick image takes), never past `text`. With `card`, a card
 * coming back starts where the reveal is now (`revealedOnReturn`). */
export function useTypewriter(text: string, streaming: boolean, budget: number | null, card?: CardMemory): number {
  const [from] = useState(() => {
    if (!card) return 0;
    const now = performance.now();
    const n = revealedOnReturn(card, text, budget, now);
    card.typed = n;
    // Finished while the card was away: the prompt's hold counts from then.
    if (n >= text.length && text && !streaming && card.promptDoneAt === null && card.typingFrom !== null) {
      card.promptDoneAt = Math.min(now, card.typingFrom + typingSeconds(text.length, budget) * 1000);
    }
    return n;
  });
  const [shown, setShown] = useState(() => (reducedMotion() ? text.length : from));
  const target = useRef({ text, streaming, budget });
  target.current = { text, streaming, budget };
  const start = useRef<number | null>(card?.typingFrom ?? null);
  useEffect(() => {
    if (reducedMotion()) return;
    let raf = 0;
    let last = performance.now();
    let n = from;
    const tick = (now: number) => {
      const { text: t, streaming: s, budget: b } = target.current;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (t.length > 0 && start.current === null) start.current = now;
      if (n < t.length) {
        const total = typingSeconds(t.length, b);
        const left = Math.max(0.4, total - (now - (start.current ?? now)) / 1000);
        const speed = Math.max(s ? 20 : TYPE_CHARS_PER_S, (t.length - n) / left);
        n = Math.min(t.length, n + speed * dt);
        setShown(n);
        if (card) {
          card.typed = n;
          card.typingFrom = start.current;
        }
      }
      // Done once everything has arrived and is on screen.
      if (s || n < t.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return reducedMotion() ? text.length : shown;
}

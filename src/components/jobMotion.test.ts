import { describe, expect, it } from "vitest";
import { cardMemory, forgetCard, newCardMemory, revealedOnReturn } from "./jobMotion";

describe("card memory", () => {
  it("gives the same memory back for a job until it is forgotten", () => {
    const m = cardMemory("job-a");
    m.typed = 42;
    m.promptGone = true;
    expect(cardMemory("job-a")).toBe(m);
    forgetCard("job-a");
    const fresh = cardMemory("job-a");
    expect(fresh).not.toBe(m);
    expect(fresh.typed).toBe(0);
    expect(fresh.promptGone).toBe(false);
    forgetCard("job-a");
  });

  it("keeps a handful of jobs, dropping the oldest", () => {
    const first = cardMemory("old-0");
    for (let i = 1; i <= 16; i++) cardMemory(`old-${i}`);
    expect(cardMemory("old-16")).toBe(cardMemory("old-16"));
    expect(cardMemory("old-0")).not.toBe(first);
    for (let i = 0; i <= 16; i++) forgetCard(`old-${i}`);
  });
});

describe("prompt shown when the card comes back", () => {
  const text = "x".repeat(320); // 10 s at 32 characters a second

  it("shows what was revealed when nothing has started yet", () => {
    const m = newCardMemory(0);
    expect(revealedOnReturn(m, text, null, 5000)).toBe(0);
    m.typed = 12;
    expect(revealedOnReturn(m, text, null, 5000)).toBe(12);
  });

  it("goes on from where the reveal is now, never back", () => {
    const m = newCardMemory(0);
    m.typingFrom = 1000;
    m.typed = 50;
    // 5 s of 10 s since the reveal started: half the text.
    expect(revealedOnReturn(m, text, null, 6000)).toBe(160);
    // Back right away: what was on screen stays.
    expect(revealedOnReturn(m, text, null, 1100)).toBe(50);
  });

  it("shows the whole prompt once its time has passed", () => {
    const m = newCardMemory(0);
    m.typingFrom = 0;
    expect(revealedOnReturn(m, text, null, 60_000)).toBe(text.length);
    // A quick image shortens the reveal (half its estimate, at least 4 s).
    expect(revealedOnReturn(m, text, 8, 4000)).toBe(text.length);
  });
});

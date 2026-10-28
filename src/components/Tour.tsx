// First-run tour: a few cards pointing at the parts of the window, walked through on the
// first example project (store.startTour). Steps whose target is not on screen are skipped.

import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { endTour, setState, useStore } from "../lib/store";

interface Step {
  target: string;
  title: string;
  text: string;
}

const STEPS: Step[] = [
  {
    target: ".stage-frame",
    title: "An example project",
    text: "Kokon Modal made these images on a PC like yours, about half a minute each. This project is yours to look around in, edit further or delete.",
  },
  {
    target: ".timeline",
    title: "Every version is kept",
    text: "A sentence made the first image. Painting an area then removed the scooter and added the cat. Click any version to go back to it and continue from there.",
  },
  {
    target: ".compare-bar",
    title: "Before and after",
    text: "Press and hold the image (or hold B) to see the version it was made from. Slider, Flicker and Changes compare the two in other ways.",
  },
  {
    target: ".composer",
    title: "Describe a change",
    text: "Type what should change in plain words, like “make it a rainy evening”, and press Enter. New image starts from a sentence instead of a picture.",
  },
  {
    target: '[data-tour="paint"]',
    title: "Change just one area",
    text: "Paint area: brush over part of the image and only that part changes. Remove, replace, add or change what is there.",
  },
  {
    target: ".side-list",
    title: "Your projects",
    text: "More examples are here. Start your own with New image, or drop or paste a photo anywhere in the window.",
  },
];

const PAD = 6;
const CARD_W = 320;
const GAP = 14;

type Box = { x: number; y: number; w: number; h: number };

function find(step: number): Box | null {
  const el = document.querySelector(STEPS[step].target);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 } : null;
}

/** The next step (in direction `d`) whose target is on screen; null past the ends. */
function nextShown(from: number, d: 1 | -1): number | null {
  for (let i = from; i >= 0 && i < STEPS.length; i += d) if (find(i)) return i;
  return null;
}

export function Tour() {
  const step = useStore((s) => s.tour);
  const overlay = useStore((s) => s.overlay);
  const [box, setBox] = useState<Box | null>(null);

  // Follow the target while the window resizes or the layout settles.
  useLayoutEffect(() => {
    if (step === null) return;
    const measure = () => setBox(find(step));
    measure();
    const t = window.setInterval(measure, 250);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("resize", measure);
    };
  }, [step]);

  const go = (d: 1 | -1) => {
    if (step === null) return;
    const n = nextShown(step + d, d);
    if (n === null) {
      if (d === 1) endTour();
    } else setState({ tour: n });
  };

  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") endTour();
      else if (e.key === "ArrowRight" || e.key === "Enter") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step]);

  // A step whose target is gone (sidebar hidden, nothing to compare) moves on by itself.
  useEffect(() => {
    if (step === null || box) return;
    const t = window.setTimeout(() => {
      if (!find(step)) go(1);
    }, 400);
    return () => window.clearTimeout(t);
  }, [step, box]);

  if (step === null || overlay) return null;
  const s = STEPS[step];
  const shown = STEPS.map((_, i) => i).filter((i) => i === step || find(i));
  const last = nextShown(step + 1, 1) === null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Below the target when it fits, otherwise above; beside it for tall targets (the sidebar).
  let left = 0;
  let top = 0;
  if (box) {
    const tall = box.h > vh * 0.5;
    if (tall) {
      left = box.x + box.w + GAP + CARD_W < vw ? box.x + box.w + GAP : box.x - GAP - CARD_W;
      top = box.y + 24;
    } else {
      left = box.x + box.w / 2 - CARD_W / 2;
      top = box.y + box.h + GAP + 190 < vh ? box.y + box.h + GAP : box.y - GAP - 190;
    }
    left = Math.max(16, Math.min(vw - CARD_W - 16, left));
    top = Math.max(16, Math.min(vh - 206, top));
  }

  return (
    <div className="tour" role="dialog" aria-label="Tour">
      {box ? <div className="tour-hole" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} /> : <div className="tour-dim" />}
      {box && (
        <div className="tour-card" style={{ left, top, width: CARD_W }}>
          <div className="tour-head">
            <strong>{s.title}</strong>
            <button className="tour-x" onClick={endTour} title="Close the tour (Esc)" aria-label="Close the tour">
              <X size={15} />
            </button>
          </div>
          <p>{s.text}</p>
          <div className="tour-foot">
            <span className="tour-dots" aria-hidden>
              {shown.map((i) => (
                <i key={i} className={i === step ? "on" : ""} />
              ))}
            </span>
            {shown[0] !== step && (
              <button className="btn" onClick={() => go(-1)}>
                Back
              </button>
            )}
            <button className="btn primary" onClick={() => go(1)}>
              {last ? "Start creating" : "Next"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

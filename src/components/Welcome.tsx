import { BasedOnKokon } from "./BasedOn";
import { ChevronLeft, ChevronRight, CloudOff, Cpu, EyeOff, Infinity as Unlimited } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import mark from "../assets/kokon-mark.svg?raw";
import demo from "../assets/showcase/kokon-demo.mp4";
import expand from "../assets/showcase/expand.jpg";
import poster from "../assets/showcase/fatto-in-casa.jpg";
import relight from "../assets/showcase/relight.jpg";
import remove from "../assets/showcase/remove.jpg";
import replace from "../assets/showcase/replace.jpg";
import restyle from "../assets/showcase/restyle.jpg";
import text from "../assets/showcase/text.jpg";
import { api } from "../lib/api";
import { WHATS_NEW_VERSION } from "./WhatsNew";
import { inBrowser, isMac } from "../lib/platform";
import { autoCheckEnabled } from "../lib/updates";
import { setState, toastError, useStore } from "../lib/store";

const machine = isMac ? "Mac" : "PC";

/** The Kokon mark in the current text color (light and dark themes). */
export function KokonMark({ size = 40 }: { size?: number }) {
  const svg = mark.replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="currentColor"').replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  return <span className="kokon-mark" aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Remembers that the welcome screen was seen (in the app config, so it survives updates)
 * and the update-check choice made on it. */
async function markSeen(updateCheck: boolean) {
  try {
    const cfg = await api.config();
    const ui = (cfg.ui ?? {}) as Record<string, unknown>;
    // A new install starts on this release: its "what's new" notes are not shown.
    if (!ui.welcomeSeen || autoCheckEnabled(ui) !== updateCheck) await api.saveConfig({ ...cfg, ui: { whatsNewSeen: WHATS_NEW_VERSION, ...ui, welcomeSeen: true, updateCheck } });
  } catch (e) {
    toastError(e);
  }
}

const PROMISES = [
  { icon: Cpu, title: `Made on your ${machine}`, text: "Your graphics chip creates every image. Photos and prompts never leave this computer." },
  { icon: CloudOff, title: "Online only when needed", text: "To download the models you choose, and once a day to check for a new Kokon Modal version. Your images and prompts are never sent." },
  { icon: Unlimited, title: "No limits", text: "No account, no credits, no subscription, no queue. Create as much as you like." },
  { icon: EyeOff, title: "Private mode", text: "Click the eye icon and nothing is kept: no gallery, no files, no history." },
];

/** First launch (and Settings → General → Show welcome screen): what Kokon is and why it is private. */
export function Welcome() {
  const needsSetup = useStore((s) => s.needsSetup);
  const [updateCheck, setUpdateCheck] = useState(true);
  useEffect(() => {
    api.config().then((c) => setUpdateCheck(autoCheckEnabled(c.ui)), () => {});
  }, []);
  const choice = useRef(updateCheck);
  choice.current = updateCheck;
  const close = () => {
    setState({ overlay: null });
    markSeen(choice.current);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="modal-scrim">
      <div className="welcome" role="dialog" aria-label="Welcome to Kokon Modal">
        <KokonMark size={44} />
        <h1>Welcome to Kokon Modal</h1>
        <BasedOnKokon />
        <p className="welcome-lead">
          A private image studio that lives on your {machine}. Describe a new image, or a change to a photo, in plain words, with the open model that suits it:
          Qwen-Image 2.1 for every kind of edit, FLUX.3 Image Klein, Fibo 2.0, Krea 2 or MOSS-Image. Switch between them in the model menu at the top. Like a cocoon,
          Kokon Modal is a closed space where something new takes shape, and nothing gets out unless you take it out.
        </p>
        <div className="welcome-grid">
          {PROMISES.map(({ icon: Icon, title, text }) => (
            <div className="welcome-item" key={title}>
              <Icon size={20} />
              <strong>{title}</strong>
              <span>{text}</span>
            </div>
          ))}
        </div>
        {!inBrowser && (
          <label className="welcome-check">
            <input type="checkbox" checked={updateCheck} onChange={(e) => setUpdateCheck(e.target.checked)} />
            Check for Kokon Modal updates once a day
          </label>
        )}
        <button className="btn primary big" onClick={close}>
          {needsSetup ? "Set up Kokon Modal" : "Start creating"}
        </button>
        <span className="muted welcome-foot">You can open this again from Settings → General.</span>
      </div>
    </div>
  );
}

const SLIDES: { src: string; video?: boolean; title: string; prompt: string }[] = [
  { src: demo, video: true, title: "One project, start to finish", prompt: "Create, edit, combine and expand: the whole flow in under a minute." },
  { src: remove, title: "Remove", prompt: "Paint the scooter · Remove · “the red scooter”" },
  { src: replace, title: "Replace", prompt: "“Replace the yellow armchair with a deep green velvet sofa and hang an abstract painting above it”" },
  { src: relight, title: "Relight", prompt: "“Make it a snowy winter night, warm light glowing from the cabin windows”" },
  { src: restyle, title: "Restyle", prompt: "“Turn it into a hand-painted watercolor illustration”" },
  { src: text, title: "Change text", prompt: "“Change the gold sign text to ‘KOKON CAFÉ’”" },
  { src: expand, title: "Expand", prompt: "Expand 40 % left and right · “continue the rocky coastline and the turquoise sea”" },
];

/** What Kokon can do, shown while the model downloads (the wait is the best moment for it). */
export function Showcase() {
  const [i, setI] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const slide = SLIDES[i];
  const go = (d: number) => setI((n) => (n + d + SLIDES.length) % SLIDES.length);
  // Photos advance every 6 s; the video advances when it ends.
  useEffect(() => {
    if (slide.video) return;
    const t = window.setTimeout(() => go(1), 6000);
    return () => window.clearTimeout(t);
  }, [i]);
  return (
    <div className="showcase">
      <div className="showcase-head">
        <strong>While you wait: what you can do</strong>
        <span className="muted">
          {i + 1} / {SLIDES.length}
        </span>
      </div>
      <div className="showcase-media">
        {slide.video ? (
          <video ref={video} key={slide.src} src={slide.src} poster={poster} autoPlay muted playsInline onEnded={() => go(1)} />
        ) : (
          <img key={slide.src} src={slide.src} alt={`${slide.title}: before and after`} />
        )}
        <button className="showcase-nav prev" onClick={() => go(-1)} aria-label="Previous">
          <ChevronLeft size={18} />
        </button>
        <button className="showcase-nav next" onClick={() => go(1)} aria-label="Next">
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="showcase-caption">
        <strong>{slide.title}</strong>
        <span>{slide.prompt}</span>
      </div>
      <div className="showcase-dots">
        {SLIDES.map((s, n) => (
          <button key={s.src} className={n === i ? "on" : ""} onClick={() => setI(n)} aria-label={s.title} />
        ))}
      </div>
    </div>
  );
}

/** Shown once everything is installed, before the first Start. */
export function ReadyTips() {
  return (
    <div className="ready-tips">
      <strong>Three ways to begin</strong>
      <ol>
        <li>Drop or paste a photo, then describe the change: “make it golden hour”.</li>
        <li>
          Switch to <b>New image</b> and describe something that does not exist yet.
        </li>
        <li>
          Use <b>Paint area</b> to brush over part of a photo, and only that part changes.
        </li>
      </ol>
      <span className="muted">Want nothing saved? Turn on Private mode with the eye icon at the top.</span>
    </div>
  );
}

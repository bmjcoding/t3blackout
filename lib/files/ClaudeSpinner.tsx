// Claude desktop's working indicator, redrawn: a few dots in the theme's accent
// colour next to a random verb. Every few seconds the verb swaps and the dots
// morph into a different motion; waiting on you has its own fixed one.
// Written into the upstream checkout by lib/rules.mjs.

import { useEffect, useRef, type ReactNode } from "react";
import "./ClaudeSpinner.css";

type Activity = "default" | "think" | "read" | "search" | "code" | "write" | "blocked";

// ------------------------------------------------------------------ poses --

// Everything is laid out in a 48-unit box and drawn at 18-20px.
type Dot = { x: number; y: number; rx: number; ry: number };
type Pose = { dots: Dot[]; ring: number };

const C = 24;
const DOTS = 4;
const dot = (x: number, y: number, r: number, ry = r): Dot => ({ x, y, rx: r, ry });
const hidden = (): Dot => dot(C, C, 0);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const TAU = Math.PI * 2;

/** Loop length in ms and the pose at `phase` in [0, 1). Every loop starts and ends where it began. */
const LOOPS: Record<Activity, { ms: number; pose: (phase: number) => Pose }> = {
  // A swell travels along a row of three.
  default: {
    ms: 1300,
    pose: (p) => ({
      ring: 0,
      dots: [
        ...[12, 24, 36].map((x, i) => {
          const w = (p - i * 0.16 + 1) % 1;
          const swell = w < 0.4 ? Math.sin((Math.PI * w) / 0.4) ** 2 : 0;
          return dot(x, C, 3.2 + 1.8 * swell);
        }),
        hidden(),
      ],
    }),
  },
  // The row rests, then turns half a circle while drawing in, twice per loop.
  think: {
    ms: 3600,
    pose: (p) => {
      const half = Math.floor(p * 2);
      const turn = ease(clamp01(((p * 2) % 1 - 0.35) / 0.65));
      const angle = (half + turn) * Math.PI;
      const spread = 12 - 5 * Math.sin(Math.PI * turn);
      const lift = 6 * Math.sin(Math.PI * turn);
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
      return {
        ring: 0,
        dots: [
          ...[-1, 0, 1].map((k, i) => {
            const along = k * spread;
            const across = k === 0 ? -lift : 0;
            const r = (k === 0 ? 3.2 : 4.2) + 0.7 * Math.sin(TAU * (p + i / 3));
            return dot(C + along * cos - across * sin, C + along * sin + across * cos, r);
          }),
          hidden(),
        ],
      };
    },
  },
  // Three dots of different sizes orbit together.
  read: {
    ms: 2000,
    pose: (p) => ({
      ring: 0,
      dots: [
        ...[4.6, 3.6, 2.2].map((r, i) => {
          const a = TAU * (p + i / 3) - Math.PI / 2;
          return dot(C + 8.5 * Math.cos(a), C + 8 * Math.sin(a), r);
        }),
        hidden(),
      ],
    }),
  },
  // The middle dot scans between the two ends, which swell as it arrives.
  search: {
    ms: 700,
    pose: (p) => {
      const s = Math.sin(TAU * p);
      return {
        ring: 0,
        dots: [
          dot(12, C, 4 + 0.9 * Math.max(0, -s) ** 4),
          dot(C + 10 * s, C, 3),
          dot(36, C, 4 + 0.9 * Math.max(0, s) ** 4),
          hidden(),
        ],
      };
    },
  },
  // Four dots on a square; each quarter, one diagonal pair trades places.
  code: {
    ms: 2600,
    pose: (p) => {
      const quarter = Math.floor(p * 4);
      const t = ease(clamp01(((p * 4) % 1 - 0.2) / 0.6));
      const corners = [
        [16, 16],
        [32, 16],
        [32, 32],
        [16, 32],
      ] as const;
      const pair = quarter % 2 === 0 ? [0, 2] : [1, 3];
      return {
        ring: 0,
        dots: corners.map(([x, y], i) => {
          const at = pair.indexOf(i);
          if (at === -1) return dot(x, y, 4);
          const [tx, ty] = corners[pair[1 - at]!]!;
          const bow = (at === 0 ? 4 : -4) * Math.sin(Math.PI * t);
          return dot(x + (tx - x) * t + bow, y + (ty - y) * t - bow, 4 - 0.8 * Math.sin(Math.PI * t));
        }),
      };
    },
  },
  // A wave runs through the row; dots stretch as they rise, like a pen moving.
  write: {
    ms: 1800,
    pose: (p) => ({
      ring: 0,
      dots: [
        ...[12, 24, 36].map((x, i) => {
          const rise = Math.max(0, Math.sin(TAU * (p - i * 0.12)));
          return dot(x, C - 6 * rise, 3.6 - 0.4 * rise, 3.6 + 1.3 * rise);
        }),
        hidden(),
      ],
    }),
  },
  // One dot with a ring breathing around it.
  blocked: {
    ms: 1400,
    pose: (p) => ({ ring: 10 + 1.2 * Math.sin(TAU * p), dots: [dot(C, C, 5.5), hidden(), hidden(), hidden()] }),
  },
};

const STILL: Pose = { ring: 0, dots: [dot(12, C, 3.6), dot(C, C, 3.6), dot(36, C, 3.6), hidden()] };

function mix(a: Pose, b: Pose, t: number): Pose {
  const n = (x: number, y: number) => x + (y - x) * t;
  return {
    ring: n(a.ring, b.ring),
    dots: a.dots.map((d, i) => {
      const e = b.dots[i]!;
      return { x: n(d.x, e.x), y: n(d.y, e.y), rx: n(d.rx, e.rx), ry: n(d.ry, e.ry) };
    }),
  };
}

// ------------------------------------------------------------------ clock --

const FRAME_MS = 1000 / 30;
const MORPH_MS = 420;
const INTRO_MS = 520;
const VERB_MS = 3_000;

const VERBS = [
  "Thinking", "Pondering", "Mulling", "Musing", "Noodling", "Puzzling", "Imagining",
  "Contemplating", "Considering", "Baking", "Brewing", "Cooking", "Simmering", "Stewing",
  "Percolating", "Marinating", "Whisking", "Concocting", "Crafting", "Creating", "Sketching",
  "Tinkering", "Doodling", "Forging", "Composing", "Hatching", "Incubating", "Vibing",
  "Grooving", "Moonwalking", "Frolicking", "Boogieing", "Shimmying", "Moseying", "Wandering",
  "Enchanting", "Manifesting", "Channeling", "Levitating", "Working", "Spinning", "Churning",
  "Finagling", "Smooshing", "Wrangling",
];

interface MarkState {
  svg: SVGSVGElement;
  shapes: SVGEllipseElement[];
  ring: SVGCircleElement;
  target: () => Activity;
  activity: Activity | null;
  born: number;
  morphFrom: Pose | null;
  morphAt: number;
  last: Pose;
}

const MOTIONS: Activity[] = ["default", "think", "read", "search", "code", "write"];

// One clock drives every mark and word on screen, so they change together.
// Marks are written straight to the DOM at 30 fps.
const marks = new Set<MarkState>();
const verbNodes = new Set<HTMLElement>();
const epoch = performance.now();
let raf = 0;
let lastFrame = 0;
let verb = pickOther(VERBS);
let motion = pickOther(MOTIONS);
let verbTimer: ReturnType<typeof setInterval> | null = null;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function pickOther<T>(from: readonly T[], previous?: T): T {
  let next = previous;
  while (next === previous) next = from[Math.floor(Math.random() * from.length)]!;
  return next!;
}

function paint(mark: MarkState, pose: Pose) {
  pose.dots.forEach((d, i) => {
    const shape = mark.shapes[i]!;
    shape.setAttribute("cx", d.x.toFixed(2));
    shape.setAttribute("cy", d.y.toFixed(2));
    shape.setAttribute("rx", Math.max(0, d.rx).toFixed(2));
    shape.setAttribute("ry", Math.max(0, d.ry).toFixed(2));
  });
  mark.ring.setAttribute("r", Math.max(0, pose.ring).toFixed(2));
  mark.ring.style.opacity = pose.ring > 0.5 ? "1" : "0";
  mark.last = pose;
}

function step(now: number, mark: MarkState) {
  const target = mark.target();
  if (target !== mark.activity) {
    if (mark.activity !== null) {
      mark.morphFrom = mark.last;
      mark.morphAt = now;
    }
    mark.activity = target;
    mark.svg.toggleAttribute("data-blocked", target === "blocked");
  }
  if (reducedMotion()) return paint(mark, target === "blocked" ? LOOPS.blocked.pose(0) : STILL);
  const loop = LOOPS[target];
  let pose = loop.pose(((now - epoch) % loop.ms) / loop.ms);
  if (mark.morphFrom) {
    const t = (now - mark.morphAt) / MORPH_MS;
    if (t >= 1) mark.morphFrom = null;
    else pose = mix(mark.morphFrom, pose, ease(t));
  }
  const intro = (now - mark.born) / INTRO_MS;
  if (intro < 1) {
    // A single dot appears, then opens out into the activity.
    const seed: Pose = { ring: 0, dots: [dot(C, C, 6 * clamp01(intro * 4)), hidden(), hidden(), hidden()] };
    pose = mix(seed, pose, ease(clamp01((intro - 0.2) / 0.8)));
  }
  paint(mark, pose);
}

function frame(now: number) {
  raf = marks.size > 0 ? requestAnimationFrame(frame) : 0;
  if (now - lastFrame < FRAME_MS - 2 || document.visibilityState !== "visible") return;
  lastFrame = now;
  for (const mark of marks) step(now, mark);
}

function swapVerb(node: HTMLElement, next: string) {
  const box = node.parentElement;
  if (reducedMotion() || typeof node.animate !== "function") {
    node.textContent = next;
    if (box) box.style.width = `${node.offsetWidth}px`;
    return;
  }
  const timing = { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" };
  const out = node.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-3px)" }], {
    ...timing,
    fill: "forwards",
  });
  out.onfinish = () => {
    node.textContent = next;
    if (box) box.style.width = `${node.offsetWidth}px`;
    node.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], timing);
    out.cancel();
  };
}

function nextVerb() {
  verb = pickOther(VERBS, verb);
  motion = pickOther(MOTIONS, motion);
  for (const node of verbNodes) swapVerb(node, verb);
}

function trackMark(state: Omit<MarkState, "activity" | "born" | "morphFrom" | "morphAt" | "last">) {
  const mark: MarkState = { ...state, activity: null, born: performance.now(), morphFrom: null, morphAt: 0, last: STILL };
  marks.add(mark);
  step(performance.now(), mark);
  if (raf === 0) raf = requestAnimationFrame(frame);
  return () => void marks.delete(mark);
}

function trackVerb(node: HTMLElement | null) {
  if (node === null) return;
  if (verbNodes.size === 0) {
    // A new turn gets a new word and motion.
    verb = pickOther(VERBS, verb);
    motion = pickOther(MOTIONS, motion);
    verbTimer = setInterval(nextVerb, VERB_MS);
  }
  verbNodes.add(node);
  node.textContent = verb;
  if (node.parentElement) node.parentElement.style.width = `${node.offsetWidth}px`;
  return () => {
    verbNodes.delete(node);
    if (verbNodes.size === 0 && verbTimer !== null) {
      clearInterval(verbTimer);
      verbTimer = null;
    }
  };
}

// ------------------------------------------------------------- components --

function WorkingMark({ activity, size }: { activity: Activity | "cycle"; size: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const activityRef = useRef(activity);
  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);
  // Attach once per mount. The row re-renders on every streamed update, and
  // re-attaching would replay the intro and drop the current activity.
  useEffect(() => {
    const svg = svgRef.current!;
    return trackMark({
      svg,
      shapes: [...svg.querySelectorAll("ellipse")],
      ring: svg.querySelector("circle")!,
      target: () => (activityRef.current === "cycle" ? motion : activityRef.current),
    });
  }, []);
  return (
    <svg ref={svgRef} viewBox="0 0 48 48" width={size} height={size} aria-hidden className="t3b-mark shrink-0">
      <circle cx={C} cy={C} r={0} fill="none" stroke="currentColor" strokeWidth={2.6} />
      {Array.from({ length: DOTS }, (_, i) => (
        <ellipse key={i} fill="currentColor" />
      ))}
    </svg>
  );
}

function Verb() {
  return (
    <span className="t3b-pulse inline-flex items-baseline text-muted-foreground" aria-hidden>
      <span className="t3b-verb-box inline-block overflow-x-clip">
        <span ref={trackVerb} className="inline-block whitespace-nowrap">
          {verb}
        </span>
      </span>
      <span className="t3b-ellipsis">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </span>
  );
}

/** Working row: `<mark> Noodling... 12s`. The mark changes motion with each new verb. */
export function ClaudeSpinnerLabel({ blocked = false, children }: { blocked?: boolean; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="sr-only">Working</span>
      <WorkingMark activity={blocked ? "blocked" : "cycle"} size={18} />
      <Verb />
      {children ? (
        <span className="text-muted-foreground" aria-hidden>
          {children}
        </span>
      ) : null}
    </span>
  );
}

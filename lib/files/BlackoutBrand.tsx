// Injected by t3blackout. The sidebar wordmark and the nightly stage art; the
// art is styled in t3blackout.css.

import { useId } from "react";

// T3 is upstream's T3Wordmark glyph, untouched, scaled from its 56-unit cap.
// BLACKOUT is lettered after the Black Ops II logo on a 100-unit cap: wide,
// heavy, rounded-square bowls, a crossbarless A.
const T3_PATH =
  "M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z";
const BLACKOUT_PATH =
  "M214.56 0H279.32A24 24 0 0 1 303.32 24V29.5A24 24 0 0 1 279.32 53.5H287.32A24 24 0 0 1 311.32 77.5V76A24 24 0 0 1 287.32 100H214.56ZM238.56 19H269.32A10 10 0 0 1 279.32 29V28.5A10 10 0 0 1 269.32 38.5H238.56V19ZM238.56 57.5H277.32A10 10 0 0 1 287.32 67.5V71A10 10 0 0 1 277.32 81H238.56V57.5ZM326.08 0L350.08 0L350.08 81L401.52 81L401.52 100L326.08 100ZM416.28 100L459.12 0L475.12 0L517.96 100L484.96 100L467.12 58.36L449.28 100ZM624.56 0H562.72A30 30 0 0 0 532.72 30V70A30 30 0 0 0 562.72 100H624.56V81H566.72A10 10 0 0 1 556.72 71V29A10 10 0 0 1 566.72 19H624.56ZM639.32 0L663.32 0L663.32 100L639.32 100ZM670.32 39L703.08 0L736.08 0L694.08 50L736.08 100L703.08 100L670.32 61ZM780.84 0H819.24A30 30 0 0 1 849.24 30V70A30 30 0 0 1 819.24 100H780.84A30 30 0 0 1 750.84 70V30A30 30 0 0 1 780.84 0ZM784.84 19H815.24A10 10 0 0 1 825.24 29V71A10 10 0 0 1 815.24 81H784.84A10 10 0 0 1 774.84 71V29A10 10 0 0 1 784.84 19ZM864 0H888V71A10 10 0 0 0 898 81H925.12A10 10 0 0 0 935.12 71V0H959.12V70A30 30 0 0 1 929.12 100H894A30 30 0 0 1 864 70ZM973.88 0L1062.44 0L1062.44 19L1030.16 19L1030.16 100L1006.16 100L1006.16 19L973.88 19Z";

/**
 * Orange T3, graphite BLACKOUT, both darkening toward the baseline. Fixed
 * colours, so it reads the same on stage art and on every theme.
 */
export function BlackoutWordmark() {
  // Rendered twice (the sidebar and its hidden width probe), so gradient ids
  // must be unique per instance.
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg
      aria-label="T3 Blackout"
      className="t3b-wordmark"
      role="img"
      viewBox="0 0 1062.44 101.72"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={`${id}-t3`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ff8a3d" />
          <stop offset="0.5" stopColor="#f26b1f" />
          <stop offset="1" stopColor="#a8410f" />
        </linearGradient>
        <linearGradient id={`${id}-ops`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#4f535a" />
          <stop offset="0.5" stopColor="#3b3e43" />
          <stop offset="1" stopColor="#1f2124" />
        </linearGradient>
      </defs>
      <path
        d={T3_PATH}
        fill={`url(#${id}-t3)`}
        transform="scale(1.785714) translate(-15.5309 -37)"
      />
      <path d={BLACKOUT_PATH} fill={`url(#${id}-ops)`} fillRule="evenodd" />
    </svg>
  );
}

/**
 * Replaces upstream's starfield: blacked-out document bars trailing off the
 * wordmark, one struck in orange. Static: no animation, nothing repaints.
 */
export function BlackoutRedactedArt() {
  return (
    <div aria-hidden="true" className="t3b-redacted h-full w-full" data-stage-art="nightly">
      <div className="t3b-redacted-bars">
        <span className="t3b-redacted-strike" />
      </div>
    </div>
  );
}

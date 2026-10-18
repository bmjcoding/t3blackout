// Injected by t3blackout. The dock icon in the theme's accent, on macOS.
//
// The app's Liquid Glass icon is compiled at build time in Blackout's orange.
// Whenever the theme's accent (--t3b-accent, t3blackout.css) is something
// else, this draws the same Redacted mark in that accent on a light and a dark
// tile and hands both to the desktop app (blackoutDockIcon.ts), which shows the
// one matching the macOS icon style in the dock while the app runs. Back on
// orange, the glass icon returns. main.tsx imports this.

const SIZE = 512;
// Blackout's accent, #f26b1f, which the bundled icon already shows.
const BUNDLED_ACCENT = [242, 107, 31] as const;

// The mark on Icon Composer's 128-unit canvas (lib/files/app-icon.icon), laid
// onto macOS's icon body: 824 of 1024 units with 100 of margin for the shadow.
const BODY = (824 / 1024) * SIZE;
const MARGIN = (100 / 1024) * SIZE;
const UNIT = BODY / 128;
const T3_PATH =
  "M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z";
const BARS: ReadonlyArray<readonly [number, number, number]> = [
  [20.48, 56.32, 58.88],
  [84.48, 56.32, 23.04],
  [20.48, 71.68, 28.16],
  [20.48, 87.04, 51.2],
  [76.8, 87.04, 30.72],
  [20.48, 102.4, 69.12],
];

type Tile = {
  readonly top: string;
  readonly bottom: string;
  readonly edge: string;
  readonly bars: string;
};

// The bundle's light and dark appearances, flattened.
const LIGHT: Tile = {
  top: "#fbfbfc",
  bottom: "#e3e3e7",
  edge: "rgb(0 0 0 / 10%)",
  bars: "rgb(26 26 28 / 55%)",
};
const DARK: Tile = {
  top: "#323234",
  bottom: "#0c0c0d",
  edge: "rgb(255 255 255 / 12%)",
  bars: "rgb(255 255 255 / 20%)",
};

function canvas2d(size: number): CanvasRenderingContext2D | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas.getContext("2d");
}

/** Any CSS colour as sRGB bytes, by painting a pixel with it. */
function toRgb(color: string): readonly [number, number, number] | null {
  const ctx = canvas2d(1);
  if (!ctx || !color) return null;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 0 ? null : [r, g, b];
}

function draw(tile: Tile, accent: string, ember: string): string | null {
  const ctx = canvas2d(SIZE);
  if (!ctx) return null;
  const radius = BODY * 0.225;

  ctx.save();
  ctx.shadowColor = "rgb(0 0 0 / 30%)";
  ctx.shadowBlur = SIZE * 0.03;
  ctx.shadowOffsetY = SIZE * 0.012;
  const body = ctx.createLinearGradient(0, MARGIN, 0, MARGIN + BODY);
  body.addColorStop(0, tile.top);
  body.addColorStop(1, tile.bottom);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.roundRect(MARGIN, MARGIN, BODY, BODY, radius);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = tile.edge;
  ctx.lineWidth = SIZE / 512;
  ctx.beginPath();
  ctx.roundRect(MARGIN + 0.5, MARGIN + 0.5, BODY - 1, BODY - 1, radius);
  ctx.stroke();

  ctx.translate(MARGIN, MARGIN);
  ctx.scale(UNIT, UNIT);

  ctx.fillStyle = tile.bars;
  for (const [x, y, width] of BARS) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, 8.96, 1.92);
    ctx.fill();
  }

  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(53.76, 74.24, 53.76, 3.84, 1.28);
  ctx.fill();

  // Ember to accent: the wordmark's deep foot goes murky on the dark tile.
  const t3 = ctx.createLinearGradient(0, 19.2, 0, 41.3);
  t3.addColorStop(0, ember);
  t3.addColorStop(1, accent);
  ctx.fillStyle = t3;
  ctx.translate(20.48, 19.2);
  ctx.scale(0.384, 0.384);
  ctx.translate(-15.5309, -37);
  ctx.fill(new Path2D(T3_PATH));

  return ctx.canvas.toDataURL("image/png");
}

let probe: HTMLElement | null = null;

/** A colour variable resolved to a plain colour; read raw, ember
 * would come back as unevaluated relative-colour text. */
function resolve(name: string): string {
  if (!probe) {
    probe = document.createElement("span");
    probe.hidden = true;
    document.documentElement.append(probe);
  }
  probe.style.color = `var(${name})`;
  return getComputedStyle(probe).color;
}

let sent: string | null = null;

function sync() {
  const bridge = window.desktopBridge;
  if (!bridge?.setBlackoutDockIcon) return;
  const accent = resolve("--t3b-accent");
  const rgb = toRgb(accent);
  if (!rgb) return;
  const bundled = rgb.every((value, index) => Math.abs(value - BUNDLED_ACCENT[index]!) <= 4);
  const key = bundled ? "bundled" : rgb.join(",");
  if (key === sent) return;
  sent = key;
  if (bundled) {
    void bridge.setBlackoutDockIcon(null).catch(() => undefined);
    return;
  }
  const ember = resolve("--t3b-ember") || accent;
  const light = draw(LIGHT, accent, ember);
  const dark = draw(DARK, accent, ember);
  if (light && dark) void bridge.setBlackoutDockIcon({ light, dark }).catch(() => undefined);
}

if (window.desktopBridge?.setBlackoutDockIcon && navigator.platform.startsWith("Mac")) {
  // useTheme.ts sets the accent as an inline style on <html>, alongside
  // data-theme-id; a theme switch or an edited palette lands here.
  let pending = 0;
  const schedule = () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(sync, 250);
  };
  new MutationObserver(schedule).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class", "data-theme-id"],
  });
  schedule();
}

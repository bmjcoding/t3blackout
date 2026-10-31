// Injected by t3blackout. The sidebar wordmark and the nightly stage art; the
// art is styled in t3blackout.css.

import { useCallback, useEffect, useId, useState, type MouseEvent, type ReactNode } from "react";

import { openDesktopUpdateReleaseNotes } from "./desktopUpdate.toast";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "./ui/dialog";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { T3BLACKOUT_BUILD } from "../t3blackoutBuild";
import { useBlackoutInterface } from "../t3blackoutInterface";

// T3 is upstream's T3Wordmark glyph, untouched, scaled from its 56-unit cap.
// BLACKOUT is lettered after the Black Ops II logo on a 100-unit cap: wide,
// heavy, rounded-square bowls, a crossbarless A.
const T3_PATH =
  "M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z";
const BLACKOUT_PATH =
  "M214.56 0H279.32A24 24 0 0 1 303.32 24V29.5A24 24 0 0 1 279.32 53.5H287.32A24 24 0 0 1 311.32 77.5V76A24 24 0 0 1 287.32 100H214.56ZM238.56 19H269.32A10 10 0 0 1 279.32 29V28.5A10 10 0 0 1 269.32 38.5H238.56V19ZM238.56 57.5H277.32A10 10 0 0 1 287.32 67.5V71A10 10 0 0 1 277.32 81H238.56V57.5ZM326.08 0L350.08 0L350.08 81L401.52 81L401.52 100L326.08 100ZM416.28 100L459.12 0L475.12 0L517.96 100L484.96 100L467.12 58.36L449.28 100ZM624.56 0H562.72A30 30 0 0 0 532.72 30V70A30 30 0 0 0 562.72 100H624.56V81H566.72A10 10 0 0 1 556.72 71V29A10 10 0 0 1 566.72 19H624.56ZM639.32 0L663.32 0L663.32 100L639.32 100ZM670.32 39L703.08 0L736.08 0L694.08 50L736.08 100L703.08 100L670.32 61ZM780.84 0H819.24A30 30 0 0 1 849.24 30V70A30 30 0 0 1 819.24 100H780.84A30 30 0 0 1 750.84 70V30A30 30 0 0 1 780.84 0ZM784.84 19H815.24A10 10 0 0 1 825.24 29V71A10 10 0 0 1 815.24 81H784.84A10 10 0 0 1 774.84 71V29A10 10 0 0 1 784.84 19ZM864 0H888V71A10 10 0 0 0 898 81H925.12A10 10 0 0 0 935.12 71V0H959.12V70A30 30 0 0 1 929.12 100H894A30 30 0 0 1 864 70ZM973.88 0L1062.44 0L1062.44 19L1030.16 19L1030.16 100L1006.16 100L1006.16 19L973.88 19Z";

/**
 * T3 in the theme's accent, graphite BLACKOUT, both darkening toward the
 * baseline. The colours come from t3blackout.css: --t3b-ember/accent/deep for
 * T3, and --t3b-ops-* for BLACKOUT.
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
          <stop offset="0" style={{ stopColor: "var(--t3b-ember, #ff8a3d)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--t3b-accent, #f26b1f)" }} />
          <stop offset="1" style={{ stopColor: "var(--t3b-deep, #a8410f)" }} />
        </linearGradient>
        <linearGradient id={`${id}-ops`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--t3b-ops-1, #4f535a)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--t3b-ops-2, #3b3e43)" }} />
          <stop offset="1" style={{ stopColor: "var(--t3b-ops-3, #1f2124)" }} />
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
 * Replaces upstream's nightly starfield: blacked-out document bars trailing off
 * the wordmark, one gap struck through in the accent. Static: no animation,
 * nothing repaints. `fallback` is upstream's art, shown when the switch is off.
 * The compact (send button) form is empty while the send button is ringed,
 * which replaces the starfield fill. The strike sits beside the bars, not in
 * them: their mask would clip it.
 */
export function BlackoutRedactedArt({ compact = false, fallback }: { compact?: boolean; fallback: ReactNode }) {
  const art = useBlackoutInterface("art");
  const send = useBlackoutInterface("send");
  if (compact) return send ? null : fallback;
  if (!art) return fallback;
  return (
    <div aria-hidden="true" className="t3b-redacted h-full w-full" data-stage-art="nightly">
      <div className="t3b-redacted-bars" />
      <span className="t3b-redacted-strike" />
    </div>
  );
}

type Change = (typeof T3BLACKOUT_BUILD)["upstream"]["items"][number];

/** Opens in the browser: through the desktop shell in the app, a new tab on the web. */
function openUrl(url: string) {
  if (window.desktopBridge) void openDesktopUpdateReleaseNotes(window.desktopBridge, url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function openLink(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  openUrl(event.currentTarget.href);
}

function ExternalLink({ href, children }: { readonly href: string; readonly children: string }) {
  return (
    <a href={href} onClick={openLink} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}

/** An upstream title with its trailing "(#1234)" turned into a pull request link. */
function UpstreamTitle({ change, repo }: { readonly change: Change; readonly repo: string | null }) {
  const pr = /^(.*?)\s*\(#(\d+)\)$/.exec(change.title);
  if (!pr || !repo) return <>{change.title}</>;
  return (
    <>
      {pr[1]} <ExternalLink href={`${repo}/pull/${pr[2]}`}>{`#${pr[2]}`}</ExternalLink>
    </>
  );
}

/** A T3 Blackout title led by its short commit ID, linked to the commit. */
function BlackoutTitle({ change, repo }: { readonly change: Change; readonly repo: string | null }) {
  const short = change.sha.slice(0, 7);
  return (
    <>
      {repo ? (
        <ExternalLink href={`${repo}/commit/${change.sha}`}>{short}</ExternalLink>
      ) : (
        <code>{short}</code>
      )}{" "}
      {change.title}
    </>
  );
}

function ChangeList({
  title,
  changes,
  empty,
  render,
}: {
  readonly title: string;
  readonly changes: (typeof T3BLACKOUT_BUILD)["upstream"];
  readonly empty: string;
  readonly render: (change: Change, repo: string | null) => ReactNode;
}) {
  const { since, items, repo } = changes;
  return (
    <section>
      <h4>
        {title}
        {since ? <span> since {since}</span> : items.length > 0 ? <span> · latest</span> : null}
      </h4>
      {items.length > 0 ? (
        <ul>
          {items.map((change) => (
            <li key={change.sha}>{render(change, repo)}</li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}

/**
 * The desktop's copy of a build's report, screenshots included (state/drift,
 * written after the build), and the staged build's preview. Cast rather than
 * typed: the bridge methods are their own feature (lib/features.mjs), and this
 * file must build without them.
 */
const blackoutBridge = () =>
  window.desktopBridge as
    | {
        getBlackoutDriftReport?: (version?: string | null) => Promise<string | null>;
        previewBlackoutBuild?: () => Promise<string | null>;
      }
    | undefined;
const reportBridge = () => blackoutBridge()?.getBlackoutDriftReport;

/** Features this build left out (lib/features.mjs), and the way into the report. */
function WhatChanged({ onOpen }: { readonly onOpen: () => void }) {
  const skipped = T3BLACKOUT_BUILD.skipped;
  if (skipped.length === 0 && !reportBridge()) return null;
  return (
    <section className="t3b-version-drift">
      {skipped.length > 0 ? (
        <>
          <h4>
            Left out<span> · upstream moved their code</span>
          </h4>
          <ul>
            {skipped.map((feature) => (
              <li key={feature.name}>
                {feature.label}
                {feature.reason === "requires" && feature.requires ? <span> (needs {feature.requires})</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <button onClick={onOpen} type="button">
        See what changed
      </button>
    </section>
  );
}

/**
 * A build that's staged and installs on restart (upstream's update state says
 * "downloaded"): open it in a sandboxed window first (`t3blackout preview`),
 * or read its report.
 */
function NextBuild({ version, onReport }: { readonly version: string; readonly onReport: () => void }) {
  const preview = blackoutBridge()?.previewBlackoutBuild;
  const [status, setStatus] = useState<string | null>(null);
  if (!preview && !reportBridge()) return null;
  const open = () => {
    if (!preview) return;
    setStatus("Opening the preview…");
    void preview()
      .then((problem) => setStatus(problem ?? "It's open in a window of its own, on a copy of your profile. Close that window when you're done."))
      .catch(() => setStatus("The preview couldn't start."));
  };
  return (
    <section className="t3b-version-drift t3b-version-next">
      <h4>
        {version}
        <span> · ready, installs on restart</span>
      </h4>
      <div>
        {preview ? (
          <button onClick={open} type="button">
            Preview
          </button>
        ) : null}
        {reportBridge() ? (
          <button onClick={onReport} type="button">
            What changed
          </button>
        ) : null}
      </div>
      {status ? <p>{status}</p> : null}
    </section>
  );
}

/**
 * A build's report (lib/drift.mjs) in a frame over the window: the desktop's
 * copy with screenshots, else for this build the one baked into
 * t3blackoutDrift.ts. `version`: another build's (a staged one). It has no
 * scripts; links open in the browser, # links scroll. Upstream's modal dialog
 * moves focus into it, keeps Tab inside, closes on Escape or a click outside,
 * and returns focus to the version stamp.
 */
function DriftReport({ version, onClose }: { readonly version: string | null; readonly onClose: () => void }) {
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const baked = () =>
      version ? Promise.resolve(null) : import("../t3blackoutDrift").then((module) => module.T3BLACKOUT_DRIFT_REPORT);
    const fromDesktop = reportBridge();
    void (fromDesktop ? fromDesktop(version).catch(() => null) : Promise.resolve(null))
      .then((report) => report ?? baked())
      .then(setHtml);
  }, [version]);
  const routeLinks = (frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument;
    doc?.addEventListener("click", (event) => {
      const link = (event.target as Element | null)?.closest?.("a[href]");
      const href = link?.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      if (href.startsWith("#")) doc.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth" });
      else openUrl(href);
    });
    // Keys inside the frame never reach the dialog.
    doc?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") onClose();
    });
  };
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogPopup bottomStickOnMobile={false} className="t3b-drift-panel" showCloseButton={false}>
        <header>
          <DialogTitle>{version ? `What changed in ${version}` : "What changed"}</DialogTitle>
          <DialogClose aria-label="Close">×</DialogClose>
        </header>
        {html ? (
          <iframe onLoad={(event) => routeLinks(event.currentTarget)} srcDoc={html} title="What changed" />
        ) : (
          <p>{html === null ? "This build has no report." : "Loading…"}</p>
        )}
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The full build version (e.g. 0.1.1-nightly.20261017.3238), stamped into the
 * window's bottom-right corner while its switch is on. Hovering or focusing it shows what the build changed, baked in at
 * build time (t3blackoutBuild.ts). The desktop's reported version wins if the
 * bundle predates a rename. A build that left features out shows a hollow dot,
 * and the card lists them with a way into what upstream changed. A staged
 * build adds a way to preview it.
 */
export function BlackoutVersionStamp() {
  return useBlackoutInterface("stamp") ? <VersionStamp /> : null;
}

function VersionStamp() {
  const update = useDesktopUpdateState();
  const build = T3BLACKOUT_BUILD;
  const version = update?.currentVersion ?? build.version ?? "dev";
  const next = update?.status === "downloaded" && update.downloadedVersion !== version ? update.downloadedVersion : null;
  // Whose report is open: this build's (null) or the staged one's.
  const [report, setReport] = useState<{ readonly version: string | null } | null>(null);
  const closeReport = useCallback(() => setReport(null), []);
  const built = build.builtAt
    ? new Date(build.builtAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div
      aria-label={`T3 Blackout ${version}`}
      className="t3b-version-stamp"
      data-drift={build.skipped.length > 0 ? "" : undefined}
      data-next={next ? "" : undefined}
      role="note"
      tabIndex={0}
    >
      <i />
      {version}
      <div className="t3b-version-notes">
        <div className="t3b-version-card">
          <header>
            <b>{version}</b>
            <small>
              {built ? `Built ${built}` : "Development build"}
              {build.upstreamSha ? ` · upstream ${build.upstreamSha.slice(0, 7)}` : ""}
            </small>
          </header>
          <ChangeList
            changes={build.upstream}
            empty="No upstream changes in this build."
            render={(change, repo) => <UpstreamTitle change={change} repo={repo} />}
            title="Upstream"
          />
          <ChangeList
            changes={build.blackout}
            empty="No T3 Blackout changes in this build."
            render={(change, repo) => <BlackoutTitle change={change} repo={repo} />}
            title="T3 Blackout"
          />
          <WhatChanged onOpen={() => setReport({ version: null })} />
          {next ? <NextBuild onReport={() => setReport({ version: next })} version={next} /> : null}
        </div>
      </div>
      {report ? <DriftReport onClose={closeReport} version={report.version} /> : null}
    </div>
  );
}

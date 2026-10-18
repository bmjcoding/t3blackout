// Injected by t3blackout. The Blackout theme's main-area background: a
// per-client preference, applied as data-t3b-backdrop on <html> for
// t3blackout.css to draw. main.tsx imports this, so it is set before the first
// paint; the storage event keeps other windows in step.

import { useSyncExternalStore } from "react";

export const BLACKOUT_BACKDROP_LABELS = {
  vignette: "Vignette",
  dots: "Dot glow",
  none: "None",
} as const;
export type BlackoutBackdrop = keyof typeof BLACKOUT_BACKDROP_LABELS;
export const DEFAULT_BLACKOUT_BACKDROP: BlackoutBackdrop = "vignette";

const STORAGE_KEY = "t3blackout:backdrop";
const listeners = new Set<() => void>();

export function isBlackoutBackdrop(value: unknown): value is BlackoutBackdrop {
  return typeof value === "string" && Object.hasOwn(BLACKOUT_BACKDROP_LABELS, value);
}

function readStored(): BlackoutBackdrop {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isBlackoutBackdrop(stored) ? stored : DEFAULT_BLACKOUT_BACKDROP;
}

let current = readStored();

function apply(value: BlackoutBackdrop) {
  current = value;
  document.documentElement.dataset.t3bBackdrop = value;
  for (const listener of listeners) listener();
}

apply(current);

window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY || event.key === null) apply(readStored());
});

export function setBlackoutBackdrop(value: BlackoutBackdrop) {
  window.localStorage.setItem(STORAGE_KEY, value);
  apply(value);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBlackoutBackdrop(): BlackoutBackdrop {
  return useSyncExternalStore(subscribe, () => current, () => DEFAULT_BLACKOUT_BACKDROP);
}

function subscribeToThemeId(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme-id"] });
  return () => observer.disconnect();
}

/** The theme on screen right now, as themePalette.ts sets it on <html>. */
export function useActiveThemeId(): string | undefined {
  return useSyncExternalStore(
    subscribeToThemeId,
    () => document.documentElement.dataset.themeId,
    () => undefined,
  );
}

// Injected by t3blackout. Window opacity for the desktop app on macOS:
// the window has macOS's HUD material behind it, a dark translucent blur
// (DesktopWindow.ts vibrancy), and this sets how much of the sidebar and main
// area's colour paints over it. A
// per-client preference, applied as --t3b-window-alpha and data-t3b-glass on
// <html> for t3blackout.css. main.tsx imports this, so it is set before the
// first paint; the storage event keeps other windows in step.

import { useSyncExternalStore } from "react";

export const MIN_WINDOW_OPACITY = 0;
export const MAX_WINDOW_OPACITY = 100;
export const DEFAULT_WINDOW_OPACITY = 100;

const STORAGE_KEY = "t3blackout:window-opacity";
const listeners = new Set<() => void>();

export function isWindowOpacity(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_WINDOW_OPACITY && value <= MAX_WINDOW_OPACITY;
}

function readStored(): number {
  const stored = Number(window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_WINDOW_OPACITY);
  return isWindowOpacity(stored) ? stored : DEFAULT_WINDOW_OPACITY;
}

let current = readStored();

function apply(value: number) {
  current = value;
  const root = document.documentElement;
  // Eased: the eye catches the desktop through even a thin gap in a dark tint,
  // so a linear 90% already reads as see-through. Squaring the gap keeps the
  // top of the slider smoky (90% -> 99% tint, 50% -> 75%) and clears at 0%.
  const gap = 1 - value / 100;
  root.style.setProperty("--t3b-window-alpha", String(1 - gap * gap));
  // Opaque windows keep upstream's backgrounds untouched.
  if (value < 100) root.dataset.t3bGlass = "";
  else delete root.dataset.t3bGlass;
  for (const listener of listeners) listener();
}

apply(current);

window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY || event.key === null) apply(readStored());
});

export function setWindowOpacity(value: number) {
  window.localStorage.setItem(STORAGE_KEY, String(value));
  apply(value);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWindowOpacity(): number {
  return useSyncExternalStore(subscribe, () => current, () => DEFAULT_WINDOW_OPACITY);
}

// Injected by t3blackout. The Blackout touches on top of whatever theme is
// selected, each a per-client switch in Settings -> Appearance -> Interface,
// on by default. Each is applied as data-t3b-<key>="on"|"off" on <html> for
// t3blackout.css, and read by BlackoutBrand.tsx. main.tsx imports this, so the
// attributes are set before the first paint; the storage event keeps other
// windows in step. Storage is best-effort: when it's blocked or full, the
// switches still work for this window and start on.

import { useSyncExternalStore } from "react";

export const BLACKOUT_INTERFACE = {
  wordmark: {
    title: "T3 BLACKOUT logo",
    description: "The sidebar logo. Off shows upstream's.",
    searchTerms: "wordmark brand sidebar logo name",
  },
  art: {
    title: "Redaction art",
    description: "Redaction bars instead of the nightly starfield at the top of the sidebar.",
    searchTerms: "redacted bars starfield nightly sidebar background stage",
  },
  send: {
    title: "Send button ring",
    description: "A ringed send button in the theme's accent, and a glow around the chat box while you type.",
    searchTerms: "send button ring composer chat box glow accent",
  },
  glow: {
    title: "Button glow",
    description: "A ring and glow when you hover the sidebar footer, update and attach buttons.",
    searchTerms: "hover glow ring buttons sidebar footer update attach accent",
  },
  stamp: {
    title: "Version stamp",
    description: "The build version in the window's bottom-right corner, with what changed and a preview of a waiting update.",
    searchTerms: "version build stamp corner changes report preview update",
  },
  selection: {
    title: "Accent text selection",
    description: "Selected text highlights in the theme's accent instead of the system color.",
    searchTerms: "highlight selected text selection color accent",
  },
} as const;

export type BlackoutInterfaceKey = keyof typeof BLACKOUT_INTERFACE;
export const BLACKOUT_INTERFACE_KEYS = Object.keys(BLACKOUT_INTERFACE) as BlackoutInterfaceKey[];

/** The switch's Settings search id (settingsSearch.ts lists them; its row carries it). */
export const blackoutInterfaceSearchId = (key: BlackoutInterfaceKey) => `t3blackout-${key}` as const;

/** Settings search entries for the switches, spread into upstream's registry. */
export const BLACKOUT_INTERFACE_SEARCH_ITEMS = BLACKOUT_INTERFACE_KEYS.map((key) => ({
  id: blackoutInterfaceSearchId(key),
  title: BLACKOUT_INTERFACE[key].title,
  to: "/settings/appearance" as const,
  searchTerms: [`t3 blackout interface ${BLACKOUT_INTERFACE[key].searchTerms}`],
}));

const storageKey = (key: BlackoutInterfaceKey) => `t3blackout:interface:${key}`;
const listeners = new Set<() => void>();

let current = Object.fromEntries(BLACKOUT_INTERFACE_KEYS.map((key) => [key, true])) as Record<
  BlackoutInterfaceKey,
  boolean
>;

/** The stored switch, or `fallback` when storage can't be read. */
function readStored(key: BlackoutInterfaceKey, fallback: boolean): boolean {
  try {
    return window.localStorage.getItem(storageKey(key)) !== "off";
  } catch {
    return fallback;
  }
}

const readAll = () =>
  Object.fromEntries(BLACKOUT_INTERFACE_KEYS.map((key) => [key, readStored(key, current[key])])) as typeof current;

function applyAll(next: Record<BlackoutInterfaceKey, boolean>) {
  current = next;
  for (const key of BLACKOUT_INTERFACE_KEYS) {
    document.documentElement.setAttribute(`data-t3b-${key}`, next[key] ? "on" : "off");
  }
  for (const listener of listeners) listener();
}

if (typeof document !== "undefined") {
  applyAll(readAll());
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith("t3blackout:interface:")) applyAll(readAll());
  });
}

/** Switches `key` in this window at once; other windows follow when storage takes it. */
export function setBlackoutInterface(key: BlackoutInterfaceKey, on: boolean) {
  applyAll({ ...current, [key]: on });
  try {
    window.localStorage.setItem(storageKey(key), on ? "on" : "off");
  } catch {
    // Blocked or full: the change holds in this window until it reloads.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBlackoutInterface(key: BlackoutInterfaceKey): boolean {
  return useSyncExternalStore(subscribe, () => current[key], () => true);
}

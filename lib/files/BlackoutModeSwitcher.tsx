// t3blackout: the Chat | Code switcher in the sidebar header, and the mode it
// switches. The mode follows the open thread (a chat or a project thread) and
// is remembered for pages that have none.

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLocation, useParams, useRouter } from "@tanstack/react-router";
import { CodeXmlIcon, MessagesSquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import {
  type BlackoutMode,
  BLACKOUT_MODE_STORAGE_KEY,
  BlackoutModeSchema,
  BlackoutThreadRefSchema,
  blackoutLastThreadStorageKey,
  isChatThreadRef,
  useStoredBlackoutMode,
} from "../blackoutChat";
import { useComposerDraftStore } from "../composerDraftStore";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useScratchProject } from "../hooks/useScratchProject";
import { readThreadShell, useProjects, useThreadShell } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export const BLACKOUT_ARTIFACTS_PATH = "/artifacts";

/** The open thread's mode: a chat's, a project thread's, or null with neither open. */
function useRouteBlackoutMode(): {
  readonly mode: BlackoutMode | null;
  readonly routeKey: string;
  readonly threadRef: ScopedThreadRef | null;
} {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const pathname = useLocation({ select: (location) => location.pathname });
  const draft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? (store.draftThreadsByThreadKey[routeTarget.draftId] ?? null) : null,
  );
  // A sent draft keeps its route; the thread it became is the one to return to.
  const threadRef =
    routeTarget?.kind === "server" ? routeTarget.threadRef : (draft?.promotedTo ?? null);
  const shell = useThreadShell(routeTarget?.kind === "server" ? routeTarget.threadRef : null);
  const projects = useProjects();
  const owner = shell ?? draft;
  const project = owner
    ? projects.find(
        (candidate) =>
          candidate.environmentId === owner.environmentId && candidate.id === owner.projectId,
      )
    : undefined;
  const routeKey =
    routeTarget?.kind === "server"
      ? `thread:${routeTarget.threadRef.environmentId}:${routeTarget.threadRef.threadId}`
      : routeTarget?.kind === "draft"
        ? `draft:${routeTarget.draftId}:${draft?.promotedTo?.threadId ?? ""}`
        : `path:${pathname}`;
  const mode = project
    ? project.isScratch === true
      ? "chat"
      : "code"
    : pathname === BLACKOUT_ARTIFACTS_PATH
      ? "chat"
      : null;
  return { mode, routeKey, threadRef };
}

export function useBlackoutMode(): BlackoutMode {
  const [stored] = useStoredBlackoutMode();
  return useRouteBlackoutMode().mode ?? stored;
}

/**
 * Remembers the mode and thread each route lands on. Keyed on the route, so a
 * switch the user just made isn't undone while its navigation is in flight.
 */
export function useBlackoutModeSync(): BlackoutMode {
  const [stored, setStored] = useStoredBlackoutMode();
  const { mode, routeKey, threadRef } = useRouteBlackoutMode();
  const syncedRouteKey = useRef<string | null>(null);
  useEffect(() => {
    if (mode === null || syncedRouteKey.current === routeKey) return;
    syncedRouteKey.current = routeKey;
    if (getLocalStorageItem(BLACKOUT_MODE_STORAGE_KEY, BlackoutModeSchema) !== mode) setStored(mode);
    if (threadRef) {
      setLocalStorageItem(blackoutLastThreadStorageKey(mode), threadRef, BlackoutThreadRefSchema);
    }
  }, [mode, routeKey, setStored, threadRef]);
  return mode ?? stored;
}

/** Opens a new chat on the primary environment, or the only one that offers chats. */
export function useStartChat() {
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useCallback(async () => {
    const environmentId =
      scratchEnvironmentId(primaryEnvironmentId) ?? scratchEnvironmentId(null);
    if (environmentId === null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Chats are unavailable",
          description:
            "Chats need a connected environment whose data folder isn't inside a Git checkout.",
        }),
      );
      return;
    }
    setLocalStorageItem(BLACKOUT_MODE_STORAGE_KEY, "chat", BlackoutModeSchema);
    await startScratchThread(environmentId);
  }, [primaryEnvironmentId, scratchEnvironmentId, startScratchThread]);
}

function useSwitchBlackoutMode() {
  const router = useRouter();
  const [, setStored] = useStoredBlackoutMode();
  const startChat = useStartChat();
  return useCallback(
    async (mode: BlackoutMode) => {
      setStored(mode);
      const last = getLocalStorageItem(blackoutLastThreadStorageKey(mode), BlackoutThreadRefSchema);
      const lastRef = last ? scopeThreadRef(last.environmentId, last.threadId) : null;
      const lastThread = lastRef ? readThreadShell(lastRef) : null;
      if (
        lastRef &&
        lastThread &&
        lastThread.archivedAt === null &&
        isChatThreadRef(lastRef) === (mode === "chat")
      ) {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(lastRef),
        });
        return;
      }
      if (mode === "chat") await startChat();
      else await router.navigate({ to: "/" });
    },
    [router, setStored, startChat],
  );
}

const SLIDE_MS = 260;
const SLIDE_EASING = "cubic-bezier(0.3, 0.7, 0.2, 1)";

// The last click's mode, held until the route reaches it, so the thumb never
// slides back while the navigation is in flight.
let heldMode: BlackoutMode | null = null;
const heldListeners = new Set<() => void>();
const readHeldMode = () => heldMode;
const subscribeHeldMode = (listener: () => void) => {
  heldListeners.add(listener);
  return () => heldListeners.delete(listener);
};
function setHeldMode(next: BlackoutMode | null) {
  if (heldMode === next) return;
  heldMode = next;
  for (const listener of heldListeners) listener();
}

/** Slides the thumb from `from` (a computed transform) to where data-mode puts it. */
function playSlide(thumb: HTMLElement, from: string) {
  for (const animation of thumb.getAnimations()) animation.cancel();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const to = getComputedStyle(thumb).transform;
  if (from === to) return;
  thumb.animate([{ transform: from }, { transform: to }], {
    duration: SLIDE_MS,
    easing: SLIDE_EASING,
  });
}

// One switch at a time, and the last click wins: a chat starting slowly must
// not land after a later switch back to code.
let switching = false;
let queuedMode: BlackoutMode | null = null;

async function drainSwitches(run: (mode: BlackoutMode) => Promise<void>) {
  if (switching) return;
  switching = true;
  try {
    while (queuedMode !== null) {
      const target = queuedMode;
      queuedMode = null;
      await run(target).catch(() => undefined);
    }
  } finally {
    switching = false;
  }
  // A switch that lands elsewhere, or nowhere, lets go of the hold too.
  setTimeout(() => {
    if (!switching && queuedMode === null) setHeldMode(null);
  }, 1500);
}

export function BlackoutModeSwitcher() {
  const mode = useBlackoutMode();
  const switchMode = useSwitchBlackoutMode();
  // The thumb moves on the click; the mode itself follows once the
  // navigation lands, which can take a moment when it starts a chat.
  const held = useSyncExternalStore(subscribeHeldMode, readHeldMode, readHeldMode);
  const shown = held ?? mode;
  useEffect(() => {
    if (held !== null && mode === held && queuedMode === null) setHeldMode(null);
  }, [held, mode]);
  const thumbRef = useRef<HTMLSpanElement>(null);
  return (
    <ToggleGroup
      aria-label="Chat or code"
      className="shrink-0"
      data-t3b-mode-switcher=""
      data-mode={shown}
      variant="segmented"
      value={[shown]}
      onValueChange={(value) => {
        const next = value[0];
        const thumb = thumbRef.current;
        if ((next !== "chat" && next !== "code") || next === shown || !thumb) return;
        // From wherever the thumb is now, mid-slide included.
        const from = getComputedStyle(thumb).transform;
        // Base UI calls this mid-render, where React can't flush, so move the
        // thumb's target directly; the render that follows sets the same.
        if (thumb.parentElement) thumb.parentElement.dataset.mode = next;
        playSlide(thumb, from);
        setHeldMode(next);
        queuedMode = next;
        // Navigate once the slide has painted, so the navigation's render
        // work can't hold its start back.
        requestAnimationFrame(() => {
          setTimeout(() => void drainSwitches(switchMode), 0);
        });
      }}
    >
      <span aria-hidden data-t3b-mode-thumb="" ref={thumbRef} />
      <Tooltip>
        <TooltipTrigger render={<Toggle aria-label="Chat" value="chat" />}>
          <MessagesSquareIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Chat</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Toggle aria-label="Code" value="code" />}>
          <CodeXmlIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Code</TooltipPopup>
      </Tooltip>
    </ToggleGroup>
  );
}

/**
 * The switcher, drawn once over the sidebar rather than in each sidebar's
 * header: switching modes swaps the sidebar, and a switcher inside it would
 * remount mid-slide. It sits under the title bar where the header's spacer
 * leaves room, starting where the wordmark does and as wide (t3blackout.css:
 * 10.445 x its 0.6875rem height), so it's centered under the logo.
 */
export function BlackoutModeSwitcherOverlay() {
  return (
    <div className="pointer-events-none absolute top-[var(--workspace-topbar-height)] left-[var(--workspace-titlebar-content-left)] z-20 flex w-[7.18rem] justify-center">
      <div className="pointer-events-auto">
        <BlackoutModeSwitcher />
      </div>
    </div>
  );
}

/** The room the overlay takes under the title bar: its 1.75rem plus a gap. */
export function BlackoutModeSwitcherSpacer() {
  return <div aria-hidden className="h-[2.125rem] shrink-0" />;
}

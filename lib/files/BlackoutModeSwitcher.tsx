// t3blackout: the Chat | Code switcher in the sidebar header, and the mode it
// switches. The mode follows the open thread (a chat or a project thread) and
// is remembered for pages that have none.

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLocation, useParams, useRouter } from "@tanstack/react-router";
import { CodeXmlIcon, MessagesSquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

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

// t3blackout.css's thumb transition.
const SLIDE_MS = 260;

// Switching modes swaps the sidebar, which remounts this switcher mid-slide.
// The new one picks the slide up where the old one was, through a negative
// transition delay, so it reads as one motion.
let lastSlide: { readonly from: BlackoutMode; readonly to: BlackoutMode; readonly at: number } | null =
  null;

function slideInProgress(to: BlackoutMode) {
  const elapsed = lastSlide === null ? SLIDE_MS : performance.now() - lastSlide.at;
  return lastSlide !== null && lastSlide.to === to && elapsed < SLIDE_MS
    ? { from: lastSlide.from, elapsed }
    : null;
}

export function BlackoutModeSwitcher() {
  const mode = useBlackoutMode();
  const switchMode = useSwitchBlackoutMode();
  // The thumb moves on the click; the mode itself follows once the
  // navigation lands, which can take a moment when it starts a chat.
  const [requested, setRequested] = useState<BlackoutMode | null>(null);
  const shown = requested ?? mode;
  const [thumb, setThumb] = useState(() => {
    const resumed = slideInProgress(shown);
    return resumed
      ? { mode: resumed.from, delayMs: -resumed.elapsed }
      : { mode: shown, delayMs: 0 };
  });
  useEffect(() => {
    if (thumb.mode === shown) return;
    // One painted frame at the start position, then the move.
    const frame = requestAnimationFrame(() => setThumb((current) => ({ ...current, mode: shown })));
    return () => cancelAnimationFrame(frame);
  }, [shown, thumb.mode]);
  useEffect(() => {
    if (thumb.delayMs === 0) return;
    // A resumed slide's head start must not carry over to the next one.
    const timer = setTimeout(() => setThumb((current) => ({ ...current, delayMs: 0 })), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [thumb.delayMs]);
  return (
    <ToggleGroup
      aria-label="Chat or code"
      className="shrink-0"
      data-t3b-mode-switcher=""
      data-mode={thumb.mode}
      variant="segmented"
      value={[shown]}
      onValueChange={(value) => {
        const next = value[0];
        if ((next !== "chat" && next !== "code") || next === shown) return;
        lastSlide = { from: shown, to: next, at: performance.now() };
        // Start the slide before the navigation's render work can hold it
        // back: commit it now, and navigate once a frame has painted.
        flushSync(() => {
          setRequested(next);
          setThumb({ mode: next, delayMs: 0 });
        });
        requestAnimationFrame(() => {
          setTimeout(() => void switchMode(next).finally(() => setRequested(null)), 0);
        });
      }}
    >
      <span
        aria-hidden
        data-t3b-mode-thumb=""
        style={thumb.delayMs === 0 ? undefined : { transitionDelay: `${thumb.delayMs}ms` }}
      />
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
 * The switcher's row, under the title bar. It starts where the wordmark does
 * and is as wide (t3blackout.css: 10.445 x its 0.6875rem height), so the
 * switcher sits centered under the logo.
 */
export function BlackoutModeSwitcherRow() {
  return (
    <div className="ml-[var(--workspace-titlebar-content-left)] flex w-[7.18rem] shrink-0 justify-center pb-1.5">
      <BlackoutModeSwitcher />
    </div>
  );
}

// t3blackout: Chat mode. A chat is a thread in upstream's "No project"
// (scratch) project: each gets its own folder, where its agent saves only .md
// and .html files (see apps/server/src/project/blackoutChatInstructions.ts).
// The sidebar shows chats in Chat mode and project threads in Code mode, and
// "Transfer to code" moves a chat, with its provider session, into a project.

import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ContextMenuItem,
  EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { FolderPlusIcon, FolderTreeIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { openCommandPalette } from "./commandPaletteBus";
import type {
  CommandPaletteActionItem,
  CommandPaletteSubmenuItem,
  CommandPaletteView,
} from "./components/CommandPalette.logic";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { getLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { readProject, readThreadShell, useProjects } from "./state/entities";
import { environmentServerConfigsAtom } from "./state/server";
import { threadEnvironment } from "./state/threads";
import { useOrchestrationCommand } from "./state/use-orchestration-command";
import { buildThreadRouteParams } from "./threadRoutes";

export type BlackoutMode = "chat" | "code";

export const BLACKOUT_MODE_STORAGE_KEY = "t3blackout:sidebar-mode";
export const BlackoutModeSchema = Schema.Literals(["chat", "code"]);

export const useStoredBlackoutMode = () =>
  useLocalStorage<BlackoutMode, BlackoutMode>(BLACKOUT_MODE_STORAGE_KEY, "code", BlackoutModeSchema);

export const readStoredBlackoutMode = (): BlackoutMode =>
  getLocalStorageItem(BLACKOUT_MODE_STORAGE_KEY, BlackoutModeSchema) ?? "code";

/** The thread each mode last showed, so switching back returns to it. */
export const blackoutLastThreadStorageKey = (mode: BlackoutMode) => `t3blackout:last-${mode}-thread`;
export const BlackoutThreadRefSchema = Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId });

const projectKey = (item: { readonly environmentId: string; readonly projectId: string }) =>
  `${item.environmentId}:${item.projectId}`;

/** `environmentId:projectId` of every environment's scratch project. */
export function useChatProjectKeys(): ReadonlySet<string> {
  const projects = useProjects();
  return useMemo(
    () =>
      new Set(
        projects
          .filter((project) => project.isScratch === true)
          .map((project) => projectKey({ environmentId: project.environmentId, projectId: project.id })),
      ),
    [projects],
  );
}

export function isChatThreadKey(
  chatProjectKeys: ReadonlySet<string>,
  thread: { readonly environmentId: string; readonly projectId: string },
): boolean {
  return chatProjectKeys.has(projectKey(thread));
}

/** Code mode's thread list: chats live in Chat mode. */
export function useBlackoutCodeThreads<
  T extends { readonly environmentId: string; readonly projectId: string },
>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  const chatProjectKeys = useChatProjectKeys();
  return useMemo(
    () =>
      chatProjectKeys.size === 0
        ? threads
        : threads.filter((thread) => !isChatThreadKey(chatProjectKeys, thread)),
    [chatProjectKeys, threads],
  );
}

/** The projects "/" may start a draft in: the scratch project in Chat mode, the rest in Code mode. */
export function projectsForBlackoutMode<T extends { readonly isScratch?: true }>(
  projects: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const chat = readStoredBlackoutMode() === "chat";
  const matching = projects.filter((project) => (project.isScratch === true) === chat);
  return matching.length > 0 ? matching : projects;
}

/** Whether `cwd` is a chat's folder, inside the environment's scratch root. */
export function useIsChatFolder(environmentId: EnvironmentId, cwd: string | null | undefined) {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const root = serverConfigs.get(environmentId)?.scratchWorkspaceRoot;
  if (!root || !cwd) return false;
  const base = root.replace(/[\\/]+$/, "");
  return cwd === base || cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`);
}

// ------------------------------------------------------- transfer to code --

// The chat waiting for the command palette to name its project. Set by
// beginTransferToCode, cleared when the palette closes.
let pendingTransfer: ScopedThreadRef | null = null;

export function beginTransferToCode(threadRef: ScopedThreadRef): void {
  pendingTransfer = threadRef;
  openCommandPalette({ open: "new-thread-in" });
}

export const isTransferToCodePending = (): boolean => pendingTransfer !== null;

export function cancelTransferToCode(): void {
  pendingTransfer = null;
}

// Read and clear in one plain function: the React Compiler folds a hook's
// `const ref = pendingTransfer` into later reads of the variable itself.
function takePendingTransfer(): ScopedThreadRef | null {
  const threadRef = pendingTransfer;
  pendingTransfer = null;
  return threadRef;
}

function transferFailed(description: string) {
  toastManager.add(
    stackedThreadToast({ type: "error", title: "Couldn't transfer to code", description }),
  );
}

/** Moves a chat into a project: its provider session resumes there on the next turn. */
export function useTransferToCode() {
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const router = useRouter();
  return useCallback(
    async (threadRef: ScopedThreadRef, projectRef: ScopedProjectRef): Promise<boolean> => {
      if (projectRef.environmentId !== threadRef.environmentId) {
        transferFailed("Pick a project on the same machine as this chat.");
        return false;
      }
      const project = readProject(projectRef);
      if (project?.isScratch === true) {
        transferFailed("Pick a project for this chat.");
        return false;
      }
      const result = await updateThreadMetadata({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          projectId: projectRef.projectId,
          worktreePath: null,
          branch: null,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          transferFailed(error instanceof Error ? error.message : "An error occurred.");
        }
        return false;
      }
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: project ? `Moved to ${project.title}` : "Moved to the project",
          description: "The conversation continues there with its context.",
        }),
      );
      return true;
    },
    [router, updateThreadMetadata],
  );
}

/**
 * Wraps the "new thread in project" handler: while a transfer is pending, the
 * project picked or created in the command palette receives the chat instead
 * of a new draft. Every palette path (an existing project, a local folder, a
 * clone, New project) ends in this handler.
 */
export function useTransferAwareNewThread<Options, Result>(
  startNewThread: (projectRef: ScopedProjectRef, options?: Options) => Promise<Result | null>,
): (projectRef: ScopedProjectRef, options?: Options) => Promise<Result | null> {
  const transferToCode = useTransferToCode();
  return useCallback(
    (projectRef: ScopedProjectRef, options?: Options) => {
      const threadRef = takePendingTransfer();
      if (threadRef === null) return startNewThread(projectRef, options);
      return transferToCode(threadRef, projectRef).then(() => null);
    },
    [startNewThread, transferToCode],
  );
}

/** The palette's project list, retitled for a transfer, without "No project", plus Add project. */
export function blackoutTransferPaletteView(input: {
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  readonly addonIconClass: string;
  readonly itemIconClass: string;
  readonly onAddProject: () => void;
}): CommandPaletteView {
  const addProject: CommandPaletteActionItem = {
    kind: "action",
    value: "t3blackout:transfer:add-project",
    searchTerms: ["add project", "new project", "folder", "clone", "repository"],
    title: "Add project",
    description: "Create a project, or add a folder or repository",
    icon: <FolderPlusIcon className={input.itemIconClass} />,
    keepOpen: true,
    run: async () => input.onAddProject(),
  };
  return {
    addonIcon: <FolderTreeIcon className={input.addonIconClass} />,
    groups: [
      {
        value: "projects",
        label: "Transfer to project",
        items: [
          ...input.items.filter((item) => item.value !== "new-thread-in:no-project"),
          addProject,
        ],
      },
    ],
  };
}

export const TRANSFER_TO_CODE_MENU_ID = "t3blackout:transfer-to-code";

/** Adds "Transfer to code" to a chat's thread menu. */
export function withTransferToCodeItem<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  thread: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
  running: boolean,
): ReadonlyArray<ContextMenuItem<T | typeof TRANSFER_TO_CODE_MENU_ID>> {
  const project = readProject(scopeProjectRef(thread.environmentId, thread.projectId));
  if (project?.isScratch !== true) return items;
  return [
    {
      id: TRANSFER_TO_CODE_MENU_ID,
      label: running ? "Transfer to code (stop it first)" : "Transfer to code…",
      icon: "folder-tree",
      disabled: running,
    },
    ...items,
  ];
}

export function isChatThreadRef(threadRef: ScopedThreadRef): boolean {
  const thread = readThreadShell(threadRef);
  if (!thread) return false;
  return readProject(scopeProjectRef(thread.environmentId, thread.projectId))?.isScratch === true;
}

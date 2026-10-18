// t3blackout: the sidebar in Chat mode (New chat, Artifacts, then pinned and
// recent chats), and the header button that transfers a chat to code.

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { FolderTreeIcon, SearchIcon, ShapesIcon, SquarePenIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { beginTransferToCode, isChatThreadKey, useChatProjectKeys } from "../blackoutChat";
import { isElectron } from "../env";
import { useThreadActionMenu } from "../hooks/useThreadActionMenu";
import { useThreadShell, useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import {
  BLACKOUT_ARTIFACTS_PATH,
  useBlackoutModeSync,
  useStartChat,
} from "./BlackoutModeSwitcher";
import { isSidebarSubagentThread } from "./Sidebar.logic";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { Button } from "./ui/button";
import {
  SidebarContent,
  SidebarGroup,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Chat mode's sidebar, or `code` (upstream's) in Code mode. */
export function BlackoutModeSidebar({ code }: { code: ReactNode }) {
  const mode = useBlackoutModeSync();
  return mode === "chat" ? <BlackoutChatSidebar /> : code;
}

/** Visible chats, newest first. */
export function useChatThreads(): ReadonlyArray<EnvironmentThreadShell> {
  const threads = useThreadShells();
  const chatProjectKeys = useChatProjectKeys();
  return useMemo(
    () =>
      threads
        .filter(
          (thread) =>
            thread.archivedAt === null &&
            !isSidebarSubagentThread(thread) &&
            isChatThreadKey(chatProjectKeys, thread),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [chatProjectKeys, threads],
  );
}

function SidebarSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-[var(--sidebar-row-content-inset)] pt-4 pb-1 text-xs text-sidebar-muted-foreground/70">
      {children}
    </div>
  );
}

function BlackoutChatSidebar() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeKey = routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const startChat = useStartChat();
  const chats = useChatThreads();
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  const visible = needle ? chats.filter((thread) => thread.title.toLowerCase().includes(needle)) : chats;
  const pinned = visible.filter((thread) => thread.pinnedAt !== null);
  const recents = visible.filter((thread) => thread.pinnedAt === null);

  // One thread menu for every row: a right-click picks its thread, and the
  // menu opens once the hook has re-bound to it.
  const [menuTarget, setMenuTarget] = useState<{
    readonly threadRef: ScopedThreadRef;
    readonly position: { readonly x: number; readonly y: number };
  } | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const { openMenu } = useThreadActionMenu({
    threadRef: menuTarget?.threadRef ?? null,
    projectCwd: null,
    onStartRename: () => {
      if (menuTarget) setRenamingKey(scopedThreadKey(menuTarget.threadRef));
    },
  });
  const openedMenuTarget = useRef<typeof menuTarget>(null);
  useEffect(() => {
    if (menuTarget === null || openedMenuTarget.current === menuTarget) return;
    openedMenuTarget.current = menuTarget;
    openMenu(menuTarget.position);
  }, [menuTarget, openMenu]);

  const row = (thread: EnvironmentThreadShell) => {
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    const key = scopedThreadKey(threadRef);
    return (
      <BlackoutChatRow
        key={key}
        thread={thread}
        active={key === activeKey}
        renaming={key === renamingKey}
        onRenameDone={() => setRenamingKey(null)}
        onOpen={() =>
          void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) })
        }
        onContextMenu={(position) => setMenuTarget({ threadRef, position })}
      />
    );
  };

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <div className="flex h-8 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
              <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
              <SidebarInput
                ref={searchInputRef}
                nativeInput
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery("");
                }}
                placeholder="Search"
                aria-label="Search chats"
                className="min-w-0 flex-1"
              />
              {query ? (
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label="Clear chat search"
                  onClick={() => {
                    setQuery("");
                    searchInputRef.current?.focus();
                  }}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : null}
            </div>
            <SidebarMenu className="mt-1">
              <SidebarMenuItem>
                <SidebarMenuButton type="button" onClick={() => void startChat()}>
                  <SquarePenIcon />
                  <span>New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  type="button"
                  isActive={pathname === BLACKOUT_ARTIFACTS_PATH}
                  onClick={() => void navigate({ to: BLACKOUT_ARTIFACTS_PATH })}
                >
                  <ShapesIcon />
                  <span>Artifacts</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1 pt-0" role="presentation">
          {pinned.length > 0 ? (
            <>
              <SidebarSectionLabel>Pinned</SidebarSectionLabel>
              <SidebarMenu aria-label="Pinned chats">{pinned.map(row)}</SidebarMenu>
            </>
          ) : null}
          <SidebarSectionLabel>Recents</SidebarSectionLabel>
          {recents.length > 0 ? (
            <SidebarMenu aria-label="Recent chats">{recents.map(row)}</SidebarMenu>
          ) : (
            <p className="px-[var(--sidebar-row-content-inset)] py-1 text-xs text-sidebar-muted-foreground/60">
              {needle ? "No chats match." : "No chats yet."}
            </p>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function BlackoutChatRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly active: boolean;
  readonly renaming: boolean;
  readonly onOpen: () => void;
  readonly onContextMenu: (position: { x: number; y: number }) => void;
  readonly onRenameDone: () => void;
}) {
  const { thread, onRenameDone } = props;
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const committed = useRef(false);
  const commitRename = (value: string) => {
    committed.current = true;
    const title = value.trim();
    onRenameDone();
    if (!title || title === thread.title) return;
    void updateThreadMetadata({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename chat",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    });
  };
  const working = !threadRuntimeCanArchive(thread.runtime);
  const needsYou = thread.hasPendingApprovals || thread.hasPendingUserInput;

  if (props.renaming) {
    return (
      <SidebarMenuItem>
        <input
          autoFocus
          aria-label="Chat title"
          className="h-8 w-full min-w-0 rounded-[var(--control-radius)] bg-transparent px-[var(--sidebar-row-content-inset)] text-sm text-sidebar-foreground outline-none ring-1 ring-inset ring-ring"
          defaultValue={thread.title}
          onFocus={(event) => {
            committed.current = false;
            event.currentTarget.select();
          }}
          onBlur={(event) => {
            if (!committed.current) commitRename(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") commitRename(event.currentTarget.value);
            else if (event.key === "Escape") {
              committed.current = true;
              onRenameDone();
            }
          }}
        />
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        type="button"
        isActive={props.active}
        data-t3b-chat-row=""
        onClick={props.onOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <span className="min-w-0 flex-1 truncate font-normal">{thread.title}</span>
        {needsYou || working ? (
          <span
            aria-label={needsYou ? "Needs your input" : "Working"}
            className={
              needsYou
                ? "size-1.5 shrink-0 rounded-full bg-warning"
                : "size-1.5 shrink-0 rounded-full bg-primary"
            }
          />
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Shown in a chat's header: moves the chat, with its context, into a project. */
export function BlackoutTransferToCodeButton(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly project: EnvironmentProject | null;
}) {
  const shell = useThreadShell(props.threadRef);
  const threadRef = props.threadRef;
  if (threadRef === null || props.project?.isScratch !== true || shell === null) return null;
  const working = !threadRuntimeCanArchive(shell.runtime);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={working}
            onClick={() => beginTransferToCode(threadRef)}
          />
        }
      >
        <FolderTreeIcon />
        Transfer to code
      </TooltipTrigger>
      <TooltipPopup side="bottom">Move this chat and its context into a project</TooltipPopup>
    </Tooltip>
  );
}

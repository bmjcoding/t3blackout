// t3blackout: every .md and .html file saved at the top of a chat's folder. Opening one
// shows its chat with the file in the app's viewer: Markdown rendered, HTML in
// its sandboxed frame with Open in browser.

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import { FileTextIcon, GlobeIcon, SearchIcon, ShapesIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isElectron } from "../env";
import { useRightPanelStore } from "../rightPanelStore";
import { projectEnvironment } from "../state/projects";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { buildThreadRouteParams } from "../threadRoutes";
import { useChatThreads } from "./BlackoutChatSidebar";
import { ScrollArea } from "./ui/scroll-area";
import { SidebarInset, SidebarInput } from "./ui/sidebar";
import { WorkspacePageContainer } from "./WorkspacePageContainer";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

const ARTIFACT_FILE = /\.(?:md|html?)$/i;
// The chat's own instructions (apps/server/src/project/blackoutChatInstructions.ts).
const INSTRUCTION_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
const LIST_CONCURRENCY = 6;

interface Artifact {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly name: string;
  readonly absolutePath: string;
  readonly kind: "markdown" | "html";
}

const displayName = (fileName: string) =>
  fileName.replace(ARTIFACT_FILE, "").replace(/[-_]+/g, " ").trim() || fileName;

export function BlackoutArtifactsPage() {
  const navigate = useNavigate();
  const chats = useChatThreads();
  const listEntries = useAtomQueryRunner(projectEnvironment.listEntries, { reportFailure: false });
  const folders = useMemo(() => chats.filter((thread) => thread.worktreePath !== null), [chats]);
  // Each chat's folder is listed again only when the chat changes.
  const foldersKey = folders
    .map((thread) => `${thread.environmentId}:${thread.id}:${thread.updatedAt}`)
    .join("|");
  const [found, setFound] = useState<{ key: string; artifacts: ReadonlyArray<Artifact> } | null>(
    null,
  );
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const artifacts: Artifact[] = [];
      for (let start = 0; start < folders.length; start += LIST_CONCURRENCY) {
        const batch = folders.slice(start, start + LIST_CONCURRENCY);
        const results = await Promise.all(
          batch.map((thread) =>
            listEntries({
              environmentId: thread.environmentId,
              input: { cwd: thread.worktreePath ?? "" },
            }),
          ),
        );
        if (cancelled) return;
        results.forEach((result, index) => {
          const thread = batch[index];
          if (!thread?.worktreePath || result._tag !== "Success") return;
          for (const entry of result.value.entries) {
            // Chats save directly in their folder; anything deeper, like a repo
            // the agent cloned to read, isn't theirs.
            const name = entry.path;
            if (
              entry.kind !== "file" ||
              /[\\/]/.test(name) ||
              !ARTIFACT_FILE.test(name) ||
              INSTRUCTION_FILES.has(name)
            ) {
              continue;
            }
            const absolutePath = `${thread.worktreePath.replace(/[\\/]+$/, "")}/${entry.path}`;
            artifacts.push({
              key: `${thread.environmentId}:${absolutePath}`,
              thread,
              name,
              absolutePath,
              kind: /\.md$/i.test(name) ? "markdown" : "html",
            });
          }
        });
      }
      if (!cancelled) setFound({ key: foldersKey, artifacts });
    })();
    return () => {
      cancelled = true;
    };
    // foldersKey stands in for folders, which it is derived from.
  }, [foldersKey, listEntries]);

  const needle = query.trim().toLowerCase();
  const artifacts = (found?.artifacts ?? []).filter(
    (artifact) =>
      !needle ||
      artifact.name.toLowerCase().includes(needle) ||
      artifact.thread.title.toLowerCase().includes(needle),
  );

  const open = async (artifact: Artifact) => {
    const threadRef = scopeThreadRef(artifact.thread.environmentId, artifact.thread.id);
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    useRightPanelStore.getState().openFile(threadRef, artifact.absolutePath);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center justify-between gap-3 py-2">
            <h1 className="text-sm font-medium">Artifacts</h1>
            <div className="flex h-8 w-56 min-w-0 items-center gap-2 rounded-md border border-border px-2 text-sm text-muted-foreground [-webkit-app-region:no-drag]">
              <SearchIcon className="size-4 shrink-0" />
              <SidebarInput
                nativeInput
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search artifacts"
                aria-label="Search artifacts"
                className="min-w-0 flex-1"
              />
            </div>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {found === null ? (
              <p className="py-12 text-center text-sm text-muted-foreground">Finding artifacts…</p>
            ) : artifacts.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-16 text-center">
                <ShapesIcon className="size-6 text-muted-foreground/70" />
                <p className="text-sm text-muted-foreground">
                  {needle
                    ? "No artifacts match."
                    : "Documents and pages your chats save show up here."}
                </p>
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {artifacts.map((artifact) => (
                  <li key={artifact.key}>
                    <button
                      type="button"
                      onClick={() => void open(artifact)}
                      className="flex w-full cursor-pointer flex-col gap-3 rounded-xl border border-border/70 bg-card/30 p-4 text-left transition-colors hover:border-border hover:bg-card/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        {artifact.kind === "markdown" ? (
                          <FileTextIcon className="size-4" />
                        ) : (
                          <GlobeIcon className="size-4" />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium text-foreground capitalize">
                          {displayName(artifact.name)}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {artifact.kind === "markdown" ? "Document" : "Page"} ·{" "}
                          {artifact.thread.title}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

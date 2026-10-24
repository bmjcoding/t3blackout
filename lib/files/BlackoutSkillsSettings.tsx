// Injected by t3blackout as Settings -> Skills and Settings -> MCP Servers
// (desktop only). Laid out like Keybindings: a search bar, then groups of
// rows. "Built in" holds what ships with Blackout or T3 Code, tagged by
// which. Each skill or server has one switch for every installed agent, and
// its agent list (behind the "All agents" disclosure) turns it off for single
// agents. The desktop app does the placing: skills are linked into each
// harness's skills folder (apps/desktop/src/ipc/methods/blackoutSkills.ts),
// servers written into each agent's config (blackoutMcp.ts). Loading or
// refreshing a page re-syncs, so an agent installed since launch catches up.

import type {
  BlackoutMcpState,
  BlackoutPlacementChange,
  BlackoutPlacementItem,
  BlackoutSkillsState,
} from "@t3tools/contracts";
import { T3_MCP_TOOL_NAMES } from "@t3tools/shared/t3McpToolPresentation";
import { ChevronRightIcon, InfoIcon, LockIcon, RefreshCwIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export const hasBlackoutSkills = () =>
  typeof window !== "undefined" && window.desktopBridge?.blackoutSkills !== undefined;

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

const matches = (query: string, item: BlackoutPlacementItem) => {
  const needle = query.trim().toLowerCase().replace(/^\//, "");
  return (
    needle.length === 0 ||
    item.name.toLowerCase().includes(needle) ||
    item.description.toLowerCase().includes(needle)
  );
};

interface Bridge<State> {
  getState: () => Promise<State>;
  set: (change: BlackoutPlacementChange) => Promise<State>;
}

/** Loads a page's state on open and applies its switches, one at a time. */
function usePlacement<State>(bridge: Bridge<State> | undefined) {
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(bridge !== undefined);

  const load = () => {
    if (!bridge) return;
    void bridge
      .getState()
      .then((next) => {
        setState(next);
        setLoadError(null);
      })
      .catch((error: unknown) => setLoadError(errorText(error)))
      .finally(() => setPending(false));
  };

  // Reads once on open; `pending` starts true for it.
  useEffect(load, []);

  const refresh = () => {
    if (!bridge || pending) return;
    setPending(true);
    load();
  };

  const change = (next: BlackoutPlacementChange, failure: string) => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge
      .set(next)
      .then(setState)
      .catch((error: unknown) => {
        toastManager.add(stackedThreadToast({ type: "error", title: failure, description: errorText(error) }));
      })
      .finally(() => setPending(false));
  };

  return { state, loadError, pending, refresh, change };
}

function SearchInput({ query, onChange, label }: { query: string; onChange: (next: string) => void; label: string }) {
  return (
    <InputGroup className="min-w-0 basis-full **:[input]:h-9 sm:basis-0 sm:flex-1 sm:**:[input]:h-8">
      <InputGroupAddon>
        <SearchIcon aria-hidden className="size-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={query}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (query.length > 0) onChange("");
          else event.currentTarget.blur();
        }}
        placeholder={label}
        aria-label={label}
        size="sm"
      />
    </InputGroup>
  );
}

function Toolbar({ children, pending, onRefresh }: { children: ReactNode; pending: boolean; onRefresh: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
      {children}
      <Button type="button" variant="outline" disabled={pending} onClick={onRefresh}>
        <RefreshCwIcon aria-hidden className="size-4" />
        Refresh
      </Button>
    </div>
  );
}

type Source = "blackout" | "t3code";

function SourceBadge({ source }: { source: Source }) {
  return source === "blackout" ? (
    <Badge size="sm" variant="label" style={{ "--label": "var(--primary)" } as CSSProperties}>
      Blackout
    </Badge>
  ) : (
    <Badge size="sm" variant="outline">
      T3 Code
    </Badge>
  );
}

function RowTitle({ title, source }: { title: string; source?: Source | undefined }) {
  return (
    <span className="flex items-center gap-2">
      {title}
      {source ? <SourceBadge source={source} /> : null}
    </span>
  );
}

function Disclosure({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <InlineButton tone="muted" aria-expanded={open} onClick={onToggle}>
      {children}
      <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
    </InlineButton>
  );
}

const subPanel = "mt-3 mb-2 rounded-lg border border-border/50 bg-background/40";
const subFoot = "border-t border-border/40 px-3 py-2 text-2xs text-muted-foreground";

function summary(item: BlackoutPlacementItem): ReactNode {
  if (!item.enabled) return "Off";
  const usable = item.agents.filter((agent) => agent.blocked === undefined);
  const on = usable.filter((agent) => agent.on).length;
  if (item.agents.length === 0) return "No agents installed";
  if (on === usable.length) return "All agents";
  return (
    <span className="text-warning">
      {on} of {usable.length} agents
    </span>
  );
}

function PlacementRow({
  item,
  title,
  source,
  mono,
  pending,
  onChange,
}: {
  item: BlackoutPlacementItem;
  title: string;
  source?: Source;
  /** Show the description as code (a server's command or URL). */
  mono?: boolean;
  pending: boolean;
  onChange: (change: BlackoutPlacementChange) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsRow
      className="rounded-none"
      title={<RowTitle title={title} source={source} />}
      description={
        <span className="flex flex-col items-start gap-1">
          {item.description ? (
            <span className={cn("line-clamp-2 break-all", mono ? "font-mono" : "break-normal")}>{item.description}</span>
          ) : null}
          {item.agents.length > 0 ? (
            <Disclosure open={open} onToggle={() => setOpen((value) => !value)}>
              {summary(item)}
            </Disclosure>
          ) : (
            <span>{summary(item)}</span>
          )}
        </span>
      }
      control={
        <Switch
          aria-label={`Turn ${title} ${item.enabled ? "off" : "on"} for every agent`}
          checked={item.enabled}
          disabled={pending}
          onCheckedChange={(checked) => onChange({ name: item.name, enabled: Boolean(checked) })}
        />
      }
    >
      {open && item.agents.length > 0 ? (
        <div className={subPanel}>
          {item.agents.map((agent) => {
            const dim = !item.enabled || agent.blocked !== undefined;
            return (
              <div
                key={agent.id}
                className="flex items-center justify-between gap-4 border-border/40 px-3 py-2 [&+&]:border-t"
              >
                <div className={cn("min-w-0", dim && "opacity-60")}>
                  <div className="text-xs font-medium text-foreground">{agent.label}</div>
                  {agent.blocked ? (
                    <div className="flex items-center gap-1 text-2xs text-warning">
                      <TriangleAlertIcon aria-hidden className="size-3" />
                      {agent.blocked}
                    </div>
                  ) : (
                    <div className="truncate font-mono text-2xs text-muted-foreground">{agent.detail}</div>
                  )}
                  {agent.note ? (
                    <div className="flex items-start gap-1 text-2xs text-muted-foreground">
                      <InfoIcon aria-hidden className="mt-px size-3 shrink-0" />
                      {agent.note}
                    </div>
                  ) : null}
                </div>
                <Switch
                  size="sm"
                  aria-label={`${title} for ${agent.label}`}
                  checked={agent.on && agent.blocked === undefined}
                  disabled={pending || dim}
                  onCheckedChange={(checked) => onChange({ name: item.name, agent: { id: agent.id, on: Boolean(checked) } })}
                />
              </div>
            );
          })}
          <div className={subFoot}>Agents you install later get it automatically.</div>
        </div>
      ) : null}
    </SettingsRow>
  );
}

const T3_TOOLS = [...T3_MCP_TOOL_NAMES].sort();
const T3_SERVER_DESCRIPTION =
  "Added by T3 to its sessions, for every agent that supports MCP tools: inline pages, threads, worktrees, scheduled tasks and more.";

/** T3's own server: handed to each session by T3, never in an agent's settings, so there's nothing to switch. */
function T3CodeServerRow() {
  const [open, setOpen] = useState(false);
  return (
    <SettingsRow
      className="rounded-none"
      title={<RowTitle title="t3-code" source="t3code" />}
      description={
        <span className="flex flex-col items-start gap-1">
          <span>{T3_SERVER_DESCRIPTION}</span>
          <Disclosure open={open} onToggle={() => setOpen((value) => !value)}>
            {T3_TOOLS.length} tools
          </Disclosure>
        </span>
      }
      control={
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LockIcon aria-hidden className="size-3.5" />
          Always on
        </span>
      }
    >
      {open ? (
        <div className={subPanel}>
          <div className="flex flex-wrap gap-1.5 px-3 py-2.5">
            {T3_TOOLS.map((tool) => (
              <code key={tool} className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                {tool}
              </code>
            ))}
          </div>
          <div className={subFoot}>
            It isn't in any agent's settings, so Blackout doesn't copy or switch it. Agents you run outside T3 don't
            have it.
          </div>
        </div>
      ) : null}
    </SettingsRow>
  );
}

function EmptyGroup({ children }: { children: ReactNode }) {
  return (
    <SettingsGroup>
      <div className="px-4 py-12 text-center text-sm text-muted-foreground">{children}</div>
    </SettingsGroup>
  );
}

function ItemSection({
  id,
  title,
  items,
  total,
  empty,
  render,
}: {
  id: string;
  title: string;
  items: ReadonlyArray<BlackoutPlacementItem>;
  total: number;
  empty: string;
  render: (item: BlackoutPlacementItem) => ReactNode;
}) {
  return (
    <SettingsSection id={id} title={`${title} · ${total}`}>
      {total === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</div>
      ) : (
        items.map(render)
      )}
    </SettingsSection>
  );
}

export function BlackoutSkillsPanel() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.blackoutSkills;
  const { state, loadError, pending, refresh, change } = usePlacement<BlackoutSkillsState>(bridge);
  const [query, setQuery] = useState("");

  const shipped = state?.shipped.filter((item) => matches(query, item)) ?? [];
  const onMachine = state?.onMachine.filter((item) => matches(query, item)) ?? [];
  const searching = query.trim().length > 0;
  const row = (item: BlackoutPlacementItem, source?: Source) => (
    <PlacementRow
      key={item.name}
      item={item}
      title={`/${item.name}`}
      {...(source ? { source } : {})}
      pending={pending}
      onChange={(next) => change(next, `Could not change /${item.name}`)}
    />
  );

  return (
    <SettingsPageContainer>
      <SettingsSection id="blackout-skills" title="Skills">
        <Toolbar pending={!bridge || pending} onRefresh={refresh}>
          <SearchInput query={query} onChange={setQuery} label="Search skills" />
        </Toolbar>
      </SettingsSection>

      {!bridge ? (
        <EmptyGroup>Skills are placed by the T3 Blackout desktop app.</EmptyGroup>
      ) : loadError ? (
        <EmptyGroup>Could not read skills: {loadError}</EmptyGroup>
      ) : state === null ? (
        <EmptyGroup>Loading skills…</EmptyGroup>
      ) : searching && shipped.length === 0 && onMachine.length === 0 ? (
        <EmptyGroup>No skills match your search.</EmptyGroup>
      ) : (
        <div className="flex flex-col gap-8">
          {shipped.length > 0 || !searching ? (
            <ItemSection
              id="blackout-skills-shipped"
              title="Built in"
              items={shipped}
              total={state.shipped.length}
              empty="No skills in this build. Add a folder to the repo's skills/ and rebuild."
              render={(item) => row(item, "blackout")}
            />
          ) : null}
          {onMachine.length > 0 || !searching ? (
            <ItemSection
              id="blackout-skills-machine"
              title="On this machine"
              items={onMachine}
              total={state.onMachine.length}
              empty="No skills of your own yet. Add one to any agent's skills folder, like ~/.claude/skills, and it shows up here."
              render={(item) => row(item)}
            />
          ) : null}
        </div>
      )}
    </SettingsPageContainer>
  );
}

export function BlackoutMcpPanel() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.blackoutMcp;
  const { state, loadError, pending, refresh, change } = usePlacement<BlackoutMcpState>(bridge);
  const [query, setQuery] = useState("");

  const servers = state?.servers.filter((item) => matches(query, item)) ?? [];
  const searching = query.trim().length > 0;
  const needle = query.trim().toLowerCase();
  const showT3 =
    !searching ||
    ["t3-code", T3_SERVER_DESCRIPTION.toLowerCase(), ...T3_TOOLS].some((text) => text.includes(needle));

  return (
    <SettingsPageContainer>
      <SettingsSection id="blackout-mcp" title="MCP Servers">
        <Toolbar pending={!bridge || pending} onRefresh={refresh}>
          <SearchInput query={query} onChange={setQuery} label="Search MCP servers" />
        </Toolbar>
      </SettingsSection>

      {state && state.problems.length > 0 ? (
        <div className="flex flex-col gap-1 px-3 text-xs text-warning sm:px-4">
          {state.problems.map((problem) => (
            <p key={problem} className="flex items-start gap-1.5">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {problem}
            </p>
          ))}
        </div>
      ) : null}

      {!bridge ? (
        <EmptyGroup>MCP servers are synced by the T3 Blackout desktop app.</EmptyGroup>
      ) : loadError ? (
        <EmptyGroup>Could not read MCP servers: {loadError}</EmptyGroup>
      ) : state === null ? (
        <EmptyGroup>Loading MCP servers…</EmptyGroup>
      ) : searching && servers.length === 0 && !showT3 ? (
        <EmptyGroup>No MCP servers match your search.</EmptyGroup>
      ) : (
        <div className="flex flex-col gap-8">
          {showT3 ? (
            <SettingsSection id="blackout-mcp-builtin" title="Built in · 1">
              <T3CodeServerRow />
            </SettingsSection>
          ) : null}
          {servers.length > 0 || !searching ? (
            <ItemSection
              id="blackout-mcp-machine"
              title="On this machine"
              items={servers}
              total={state.servers.length}
              empty="No MCP servers yet. Add one to any agent, for example with claude mcp add, and it shows up here."
              render={(item) => (
                <PlacementRow
                  key={item.name}
                  item={item}
                  title={item.name}
                  mono
                  pending={pending}
                  onChange={(next) => change(next, `Could not change ${item.name}`)}
                />
              )}
            />
          ) : null}
        </div>
      )}
    </SettingsPageContainer>
  );
}

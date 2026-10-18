// Injected by t3blackout as Settings -> Skills (desktop only). One switch per
// skill Blackout ships (the repo's skills/ folder); the desktop app links each
// enabled one into every installed agent harness
// (apps/desktop/src/ipc/methods/blackoutSkills.ts). Loading or refreshing the
// page re-links, so a harness installed since launch picks them up.

import type { BlackoutSkillState } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export const hasBlackoutSkills = () =>
  typeof window !== "undefined" && window.desktopBridge?.blackoutSkills !== undefined;

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

function placementText(skill: BlackoutSkillState): string {
  if (!skill.enabled) return "Off. Not linked into any agent.";
  const parts: string[] = [];
  if (skill.placed.length > 0) parts.push(`Linked for ${skill.placed.join(", ")}.`);
  if (skill.skipped.length > 0) {
    parts.push(`Skipped for ${skill.skipped.join(", ")}: you have your own skill named ${skill.name} there.`);
  }
  if (parts.length === 0) parts.push("No supported agent is installed yet. It links once one is.");
  return parts.join(" ");
}

export function BlackoutSkillsPanel() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.blackoutSkills;
  const [skills, setSkills] = useState<ReadonlyArray<BlackoutSkillState> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(() => {
    if (!bridge) return;
    setPending(true);
    void bridge
      .getState()
      .then((next) => {
        setSkills(next);
        setLoadError(null);
      })
      .catch((error: unknown) => setLoadError(errorText(error)))
      .finally(() => setPending(false));
  }, [bridge]);

  useEffect(refresh, [refresh]);

  const setEnabled = (name: string, enabled: boolean) => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge
      .setEnabled({ name, enabled })
      .then(setSkills)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not turn /${name} ${enabled ? "on" : "off"}`,
            description: errorText(error),
          }),
        );
      })
      .finally(() => setPending(false));
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="blackout-skills"
        title={skills ? `Comes with Blackout · ${skills.length}` : "Comes with Blackout"}
        headerAction={
          bridge ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={refresh}>
              <RefreshCwIcon className="size-3.5" />
              Refresh
            </Button>
          ) : null
        }
      >
        {!bridge ? (
          <SettingsRow title="Desktop only" description="Skills are placed by the T3 Blackout desktop app." />
        ) : loadError ? (
          <SettingsRow title="Could not read skills" description={loadError} />
        ) : skills === null ? (
          <SettingsRow title="Loading skills…" />
        ) : skills.length === 0 ? (
          <SettingsRow title="No skills in this build" description="Add a folder to the repo's skills/ and rebuild." />
        ) : (
          skills.map((skill) => (
            <SettingsRow
              key={skill.name}
              title={`/${skill.name}`}
              description={
                <>
                  {skill.description}
                  <br />
                  <span className="text-muted-foreground/80">{placementText(skill)}</span>
                </>
              }
              control={
                <Switch
                  aria-label={`Turn /${skill.name} ${skill.enabled ? "off" : "on"}`}
                  checked={skill.enabled}
                  disabled={pending}
                  onCheckedChange={(checked) => setEnabled(skill.name, Boolean(checked))}
                />
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

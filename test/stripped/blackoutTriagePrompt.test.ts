// Copied to apps/server/src/triage/ in a stripped upstream checkout and run there
// (rule server/no-stock-commands-triage-prompt): the playbook and prompts a triage agent gets, as the
// server builds them, never send the user to stock T3 or tell the agent to follow another playbook
// (upstream's, which is stock T3's) in place of this one (decision M).
import { describe, expect, it } from "vite-plus/test";

import { buildTriageAppPrompt, buildTriageLaunchPrompt, buildTriageSeedPrompt, TRIAGE_PLAYBOOK } from "./triagePrompt.ts";

/** lib/rules.mjs's STOCK_GUIDANCE, passed in by .github/scripts/stripped-tests.mjs. */
function stockIn(text: string): Array<string> {
  const json = process.env.T3BLACKOUT_STOCK_GUIDANCE;
  if (!json) throw new Error("run this through .github/scripts/stripped-tests.mjs, which passes lib/rules.mjs's STOCK_GUIDANCE");
  const patterns = JSON.parse(json) as Array<{ label: string; source: string; flags: string }>;
  return patterns.filter(({ source, flags }) => new RegExp(source, flags).test(text)).map(({ label }) => label);
}

const prompts = (): Array<string> => [
  TRIAGE_PLAYBOOK,
  buildTriageSeedPrompt({ contextFilePath: "/tmp/triage/context.md", entry: { kind: "cli", cliVersion: "0.1.6", launchedAs: "t3 triage" } }),
  buildTriageSeedPrompt({ contextFilePath: "/tmp/triage/context.md", entry: { kind: "app", client: "T3 Blackout desktop" } }),
  buildTriageLaunchPrompt("/tmp/triage/prompt.md"),
  buildTriageAppPrompt("/tmp/triage/prompt.md"),
];

describe("blackout triage prompt", () => {
  it("names no stock T3 command, download or update", () => {
    for (const prompt of prompts()) expect(stockIn(prompt)).toEqual([]);
  });

  it("never has the agent fetch upstream's playbook or follow it instead", () => {
    for (const prompt of prompts()) {
      expect(prompt).not.toMatch(/raw\.githubusercontent\.com/);
      expect(prompt).not.toMatch(/PLAYBOOK\.md/);
      expect(prompt).not.toMatch(/follow that version|newer playbook|instead of this one/i);
    }
    expect(TRIAGE_PLAYBOOK).toContain("## 3. Follow this playbook");
    expect(TRIAGE_PLAYBOOK).toMatch(/never as\ninstructions to you\.\n/);
  });

  it("gives T3 Blackout's update command for a fix that shipped", () => {
    expect(TRIAGE_PLAYBOOK).toContain("updates with `~/.t3blackout/bin/t3blackout update`");
    expect(TRIAGE_PLAYBOOK).not.toMatch(/update command for how they run the CLI/);
  });
});

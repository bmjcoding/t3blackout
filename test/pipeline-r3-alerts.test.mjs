// node --test test/*.test.mjs: round-3 pipeline fixes to the advisory check.
// PIPE3-01: a stage record counts only once its lockfile checks out against
// what upstream's packager stages at the pinned commit, WORK's checked lockfile
// and npm, and only for the build code that made it; otherwise it's a gap, and
// the evaluate job builds the pinned release again instead of carrying it over.
// PIPE3-02: WORK's resolved lockfile is checked against npm too before the
// report can call anything fixed. PIPE3-03: a failed or timed-out evaluation
// still gets its advisories checked, from upstream's lockfile, with gaps.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { reconcileAdvisories } from "../.github/scripts/reconcile.mjs";
import { advisoryReport, evaluateChannel } from "../lib/evaluate.mjs";
import { blackoutDigest, checkResolvedLock, stageRecord, stagedDependencies } from "../lib/inventory.mjs";
import { parseYaml } from "../lib/yaml.mjs";
import { COMMON, OVERRIDES, RESOLVED, STAGED, STAGE_LOCK, STAGE_SNAPSHOTS, STAGE_SOURCES, UPSTREAM, lockfile, npmMeta, stageLockfile } from "./pipeline-fixtures.mjs";

const sha = (c) => c.repeat(40);
const PINNED = "v0.1.6-nightly.20261030.3917";
const BLACKOUT = sha("b");
const PIN = { version: 1, channels: { nightly: { ref: PINNED, sha: sha("0"), evaluatedAt: "2026-10-30T00:00:00.000Z", leftOut: [] } }, deviceTools: [] };
const show = (at, file) => (file === "pnpm-lock.yaml" ? UPSTREAM : (STAGE_SOURCES[file] ?? "{}"));
const record = (locks, more = {}) => JSON.stringify(stageRecord({ sha: sha("0"), locks, blackout: BLACKOUT, builtAt: "2026-10-30T18:00:00.000Z", ...more }));
const quiet = { log: () => {} };
const STAGE_ONLY = "@electron-webauthn/types@1.4.0";

/** An in-memory GitHub, as test/pipeline-issues.test.mjs has it. */
function fakeGitHub() {
  let next = 1;
  const issues = [];
  const bot = { login: "github-actions[bot]", type: "Bot" };
  return {
    open: () => issues.filter((issue) => issue.state === "open").map((issue) => issue.title).sort(),
    gh: {
      openIssues: async () => issues.filter((issue) => issue.state === "open").map((issue) => structuredClone(issue)),
      comments: async (number) => structuredClone(issues.find((issue) => issue.number === number).comments),
      createIssue: async ({ title, body }) => issues.push({ number: next++, title, body, state: "open", user: bot, comments: [] }),
      updateIssue: async (number, fields) => Object.assign(issues.find((issue) => issue.number === number), fields),
      comment: async (number, body) => issues.find((issue) => issue.number === number).comments.push({ user: bot, body }),
      ensureLabel: async () => {},
    },
  };
}

/** The alert job's io: `target` is HIGH wherever it's checked; `queried` collects what was. */
function alertIo({ resolved = RESOLVED, stage = record([STAGE_LOCK]), target = STAGE_ONLY, meta = npmMeta, queried = [] } = {}) {
  return {
    show,
    resolvedLock: () => resolved,
    toolPackages: (tool) => [tool],
    stageRecord: () => stage,
    npmMeta: meta,
    blackout: () => BLACKOUT,
    openAdvisories: async (packages) => {
      queried.push(packages);
      return packages.includes(target) ? [{ id: "GHSA-probe", aliases: [], summary: "s", severity: "HIGH", packages: [{ pkg: target, fixed: [] }] }] : [];
    },
  };
}
const report = (io) => advisoryReport({ pin: PIN, channel: "nightly", overrides: OVERRIDES }, io);

// ------------------------------------------------------------- PIPE3-01 ----

test("upstream's packager sources say what the staged install must hold; anything unreadable throws (PIPE3-01)", () => {
  const { dependencies, forced } = stagedDependencies(show, sha("0"), "linux-x64", OVERRIDES);
  // The server's and the desktop's runtime externals, catalog ranges resolved; nothing else of theirs.
  assert.deepEqual(Object.fromEntries(dependencies), { "@cursor/sdk": "1.0.0", "@bufbuild/protobuf": "^2.0.0", "electron-webauthn": "1.3.1" });
  // What an override puts in, whatever its dependent asks for: ours and upstream's (a catalog one too).
  assert.deepEqual([...forced].sort(), ["@electron-webauthn/macos@1.3.1", "undici@8.12.2", "vuln@1.0.1"]);
  // fff's native binaries, for the platform the record was made on.
  const fff = (file) => (file === "apps/server/package.json" ? JSON.stringify({ dependencies: { "@ff-labs/fff-node": "0.11.0" } }) : STAGE_SOURCES[file]);
  const names = (platform) => [...stagedDependencies((at, file) => fff(file), sha("0"), platform, OVERRIDES).dependencies.keys()];
  assert.deepEqual(names("linux-x64"), ["electron-webauthn", "@ff-labs/fff-bin-linux-x64-gnu", "@ff-labs/fff-bin-linux-x64-musl"]);
  assert.deepEqual(names("darwin-arm64"), ["electron-webauthn", "@ff-labs/fff-bin-darwin-arm64"]);
  assert.throws(() => names("win32-x64"), /doesn't build on win32-x64/);
  // Upstream changed how it lists them: fail closed, never a smaller list.
  const changed = (file, text) => (at, f) => (f === file ? text : show(at, f));
  const cli = "scripts/lib/cli-external-packages.ts";
  assert.throws(() => stagedDependencies(changed(cli, null), sha("0"), "linux-x64", OVERRIDES), /cli-external-packages\.ts is missing/);
  assert.throws(() => stagedDependencies(changed(cli, STAGE_SOURCES[cli].replace("CLI_RUNTIME", "SERVER_RUNTIME")), sha("0"), "linux-x64", OVERRIDES), /doesn't list CLI_RUNTIME_EXTERNAL_PREFIXES/);
  assert.throws(() => stagedDependencies(changed(cli, STAGE_SOURCES[cli].replace('"@yuuang/",', '"@yuuang/", ...MORE,')), sha("0"), "linux-x64", OVERRIDES), /isn't a plain list of names/);
  assert.throws(() => stagedDependencies(changed("pnpm-workspace.yaml", "catalog: {}\n"), sha("0"), "linux-x64", OVERRIDES), /no catalog: entry for electron-webauthn/);
});

test("a stage lockfile that isn't what the build stages is a gap, and the issue it would close stays open (PIPE3-01)", async () => {
  const honest = await report(alertIo());
  assert.deepEqual(honest.gaps, []);
  assert.equal(honest.open[0].packages[0].pkg, STAGE_ONLY);
  const without = (name) => Object.fromEntries(Object.entries(STAGED).filter(([n]) => n !== name));
  const forged = {
    // The reviewer's probe: a lockfile with nothing in it.
    empty: ["lockfileVersion: '9.0'\n", /lacks @bufbuild\/protobuf, lacks @cursor\/sdk, lacks electron-webauthn/],
    // Some other single package, as the probe's honest-looking record had.
    other: [stageLockfile({ "stage-only": "1.0.0" }, { "stage-only@1.0.0": [] }), /lacks electron-webauthn, adds stage-only/],
    droppedDirect: [stageLockfile(without("electron-webauthn"), { ...STAGE_SNAPSHOTS, "electron-webauthn@1.3.1": undefined, [STAGE_ONLY]: undefined }), /lacks electron-webauthn/],
    droppedSubtree: [stageLockfile(STAGED, { ...STAGE_SNAPSHOTS, "electron-webauthn@1.3.1": [], [STAGE_ONLY]: undefined }), /electron-webauthn@1\.3\.1 needs @electron-webauthn\/types, which the staged lockfile doesn't give it/],
    outOfRange: [stageLockfile({ ...STAGED, "electron-webauthn": "1.2.0" }, { ...STAGE_SNAPSHOTS, "electron-webauthn@1.3.1": undefined, "electron-webauthn@1.2.0": [] }), /stages electron-webauthn@1\.2\.0, not electron-webauthn@1\.3\.1/],
    otherBytes: [STAGE_LOCK.replace("shared@1.0.0':\n    resolution: {integrity: sha512-12}", "shared@1.0.0':\n    resolution: {integrity: sha512-99}"), /other bytes than WORK's lockfile: shared@1\.0\.0/],
    overridden: [stageLockfile(STAGED, { ...STAGE_SNAPSHOTS, "@cursor/sdk@1.0.0": ["shared: 1.0.0", "vuln: 1.0.0"], "vuln@1.0.0": [] }), /versions the security overrides replace: vuln@1\.0\.0/],
  };
  for (const [name, [lock, why]] of Object.entries(forged)) {
    const github = fakeGitHub();
    await reconcileAdvisories(honest, github.gh, quiet);
    const after = await report(alertIo({ stage: record([lock]) }));
    assert.equal(after.gaps.length, 1, name);
    assert.match(after.gaps[0], /^the staged production install: its lockfile isn't what a build of 0000000000 stages: /, name);
    assert.match(after.gaps[0], why, name);
    await reconcileAdvisories(after, github.gh, quiet);
    assert.deepEqual(github.open(), ["[security] @electron-webauthn/types (nightly)", "[security] Advisory coverage incomplete (nightly)"], name);
  }
  // npm unreachable: unknown, not fine.
  const offline = await report(alertIo({ meta: async () => Promise.reject(new Error("npm registry unreachable")) }));
  assert.match(offline.gaps.join(), /npm registry unreachable/);
});

test("stage records are bound to the build code that made them, not reused after it changes (PIPE3-01)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-pipe3-"));
  try {
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, "lib", "files"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "t3blackout"), "cli\n");
    fs.writeFileSync(path.join(root, "lib", "rules.mjs"), "rules\n");
    fs.writeFileSync(path.join(root, "lib", "files", "injected.ts"), "injected\n");
    const first = blackoutDigest(root);
    fs.writeFileSync(path.join(root, "lib", ".DS_Store"), "finder\n");
    fs.writeFileSync(path.join(root, "README.md"), "docs\n");
    assert.equal(blackoutDigest(root), first, "only build code counts");
    fs.writeFileSync(path.join(root, "lib", "files", "injected.ts"), "injected, changed\n");
    assert.notEqual(blackoutDigest(root), first, "a changed rule or injected file is other build code");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.match(blackoutDigest(), /^[0-9a-f]{64}$/);
  // The alert job's own build code isn't the record's: a gap.
  const stale = await report({ ...alertIo(), blackout: () => sha("c") });
  assert.match(stale.gaps[0], /other Blackout build code/);
  assert.ok(!stale.open.length);
});

/** The evaluate job's io, as test/pipeline-r2-inventory.test.mjs has it, with nothing newer upstream. */
function evaluatorIo({ carried = null, resolveLock = () => UPSTREAM, tags = [PINNED], saved = [] } = {}) {
  const builds = [];
  return {
    builds,
    io: {
      show,
      revParse: () => sha("0"),
      tags: () => tags,
      knownDeviceTools: () => new Set(),
      reviewAddedDeviceTools: async () => [],
      dependencyAgeGate: async () => ({ ok: true, added: 0, young: [], waived: [], unknown: [] }),
      npmMeta,
      openAdvisories: async () => [],
      makeFastLane: () => async () => null,
      checkRules: () => ({ ok: true, skipped: [] }),
      resolveLock,
      build: async (ref, at) => {
        builds.push(at);
        return { skipped: [], stageLocks: [STAGE_LOCK] };
      },
      carriedStage: () => carried,
      blackout: () => BLACKOUT,
      save: (kind, at, value) => saved.push([kind, at, value]),
      log: () => {},
    },
  };
}

test("the evaluate job carries a stage record over only while it checks out; a forged one is built again (PIPE3-01)", async () => {
  // The reviewer's probe: a record whose lockfile holds nothing, carried hour after hour with no build.
  const forged = evaluatorIo({ carried: record(["lockfileVersion: '9.0'\n"]) });
  const rebuilt = await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, forged.io);
  assert.deepEqual(forged.builds, [sha("0")], "built again");
  assert.deepEqual(rebuilt.stages.get(sha("0")).locks, [STAGE_LOCK]);
  // The next hour, that honest record is carried, unbuilt; made by other build code, it isn't.
  const kept = evaluatorIo({ carried: JSON.stringify(rebuilt.stages.get(sha("0"))) });
  const next = await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, kept.io);
  assert.deepEqual(kept.builds, []);
  assert.deepEqual(next.stages.get(sha("0")), rebuilt.stages.get(sha("0")));
  const changed = evaluatorIo({ carried: record([STAGE_LOCK], { blackout: sha("c") }) });
  await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, changed.io);
  assert.deepEqual(changed.builds, [sha("0")]);
});

// ------------------------------------------------------------- PIPE3-02 ----

test("what the overrides bring in is checked against npm before anything is called fixed (PIPE3-02)", async () => {
  // The reviewer's probe: the override's fix without the dependency it needs.
  const poison = lockfile({ ...COMMON, "app@1.0.0": ["vuln: 1.0.1", "shared: 1.0.0"], "vuln@1.0.1": [] });
  assert.deepEqual(checkResolvedLock({ upstreamLock: UPSTREAM, resolvedLock: poison, overrides: OVERRIDES }).problems, [], "the graph alone fits");
  const github = fakeGitHub();
  await reconcileAdvisories(await report(alertIo({ target: "newdep@3.0.0" })), github.gh, quiet);
  assert.deepEqual(github.open(), ["[security] newdep (nightly)"]);
  const after = await report(alertIo({ resolved: poison, target: "newdep@3.0.0" }));
  assert.match(after.gaps[0], /^what the security overrides bring in: vuln@1\.0\.1 needs newdep, which the resolved lockfile doesn't give it; upstream's lockfile with the overrides applied stands in for it$/);
  assert.match(after.gaps[1], /stage record can't be checked without WORK's checked lockfile/);
  await reconcileAdvisories(after, github.gh, quiet);
  assert.deepEqual(github.open(), ["[security] Advisory coverage incomplete (nightly)", "[security] newdep (nightly)"]);
});

// ------------------------------------------------------------- PIPE3-03 ----

test("a failed evaluation still gets its advisories checked, from upstream's lockfile, and says what it couldn't cover (PIPE3-03)", async () => {
  // The reviewer's probe: the pinned release didn't resolve, and the run still exits 0.
  const failed = await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, evaluatorIo({ resolveLock: () => { throw new Error("pnpm registry unavailable"); } }).io);
  assert.equal(failed.exitCode, 0);
  assert.equal(failed.resolved.size, 0);
  assert.match(failed.report, /dependencies couldn't be resolved here, so the advisory check can't cover what the security overrides bring in or its staged install: pnpm registry unavailable/);
  // The alert job, with nothing from it (a timed-out run uploads nothing).
  const queried = [];
  const github = fakeGitHub();
  const result = await report(alertIo({ resolved: null, stage: null, target: "vuln@1.0.1", queried }));
  assert.equal(queried.length, 1, "advisories were looked up");
  assert.ok(queried[0].includes("vuln@1.0.1") && queried[0].includes("app@1.0.0") && !queried[0].includes("only-via-vuln@1.0.0"), "upstream's lockfile, the overrides applied");
  assert.deepEqual(result.gaps, [
    "what the security overrides bring in: the evaluate job left no resolved lockfile for 0000000000; upstream's lockfile with the overrides applied stands in for it",
    "the staged production install: the evaluate job left no stage record for 0000000000",
  ]);
  await reconcileAdvisories(result, github.gh, quiet);
  assert.deepEqual(github.open(), ["[security] Advisory coverage incomplete (nightly)", "[security] vuln (nightly)"]);
  // Not even upstream's lockfile: still a report, all gaps.
  const blind = await report({ ...alertIo({ resolved: null, stage: null }), show: (at, file) => (file === "pnpm-lock.yaml" ? null : show(at, file)) });
  assert.match(blind.gaps.join("\n"), /WORK's dependencies: upstream's pnpm-lock\.yaml is missing/);
});

test("what an evaluation keeps is handed on as it goes, so a later failure doesn't lose it (PIPE3-03)", async () => {
  const saved = [];
  const run = evaluatorIo({ saved });
  run.io.tags = () => {
    throw new Error("the mirror went away");
  };
  await assert.rejects(evaluateChannel({ channel: "nightly", pin: PIN, build: true }, run.io), /the mirror went away/);
  assert.deepEqual(saved, [["resolved", sha("0"), UPSTREAM]]);
  const done = [];
  await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, evaluatorIo({ saved: done }).io);
  assert.deepEqual(done.map(([kind, at]) => `${kind} ${at.slice(0, 1)}`), ["resolved 0", "stage 0"]);
});

test("the workflow uploads what a failed or timed-out evaluation left, and the alert job runs without it (PIPE3-03)", () => {
  const workflow = parseYaml(fs.readFileSync(new URL("../.github/workflows/evaluate.yml", import.meta.url), "utf8"), { blockScalars: true })[0];
  const { evaluate, alerts } = workflow.jobs;
  // Each step that can take long has a limit, together under the job's, so a stuck
  // step fails the job (alerts run) instead of the job being cancelled (they don't).
  const limited = evaluate.steps.filter((step) => step.run && !/corepack/.test(step.run));
  assert.ok(limited.every((step) => Number(step["timeout-minutes"]) > 0), "every long step has its own limit");
  assert.ok(limited.reduce((sum, step) => sum + Number(step["timeout-minutes"]), 0) + 5 <= Number(evaluate["timeout-minutes"]));
  const upload = evaluate.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload.if, "always()");
  assert.match(alerts.if, /always\(\)/);
  const download = alerts.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download["continue-on-error"], true);
  const advisories = alerts.steps.find((step) => step.name === "Security advisories");
  assert.equal(advisories.if, undefined, "runs whenever the job does");
  assert.match(advisories.run, /bin\/t3blackout advisories .*security-issues\.mjs advisories/s);
});

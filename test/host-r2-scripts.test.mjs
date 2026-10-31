// node --test test/: scripts/add-agent-account.sh's agent-home lockdown, sourced
// for its functions with as_user stubbed (everything runs as you, unprivileged)
// on a scratch "home" with real macOS ACLs.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ADD_ACCOUNT = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), "scripts", "add-agent-account.sh");
const isMac = process.platform === "darwin";
const acl = (dir) => spawnSync("/bin/ls", ["-led", dir], { encoding: "utf8" }).stdout;

/**
 * prepare_agent_home on a fresh scratch home carrying `everyone allow
 * list,search`. `otherCanOpen`: what the check from your account sees;
 * `skipStrip`: chmod -N does nothing (an ACL that won't go).
 */
function prepare({ otherCanOpen = false, skipStrip = false } = {}) {
  const home = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-agent-home-"))), "agent");
  fs.mkdirSync(home, { mode: 0o750 });
  assert.equal(spawnSync("/bin/chmod", ["+a", "everyone allow list,search", home]).status, 0);
  const script = `
source ${JSON.stringify(ADD_ACCOUNT)}
NAME=agent-test SUDO_USER=admin-test HOME_DIR=${JSON.stringify(home)}
seed_pricing() { :; }
as_user() {
  local user="$1"; shift
  if [[ "$user" == "$SUDO_USER" && "$1" == /bin/test ]]; then ${otherCanOpen ? "return 0" : "return 1"}; fi
  if [[ "$1" == /bin/chmod && "$2" == -N && -n "${skipStrip ? "skip" : ""}" ]]; then return 0; fi
  "$@"
}
prepare_agent_home
echo PREPARED`;
  return { home, result: spawnSync("bash", ["-c", script], { encoding: "utf8" }) };
}

test("an agent home's ACL entries are removed, keeping only macOS's deny delete (HOST2-02)", { skip: !isMac && "macOS ACLs" }, () => {
  const { home, result } = prepare();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PREPARED/);
  const listed = acl(home);
  assert.doesNotMatch(listed, /allow/);
  assert.match(listed, /group:everyone deny delete/);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, ".t3blackout")).mode & 0o777, 0o700);
});

test("an ACL that survives, or a home your account can still open, stops provisioning (HOST2-02)", { skip: !isMac && "macOS ACLs" }, () => {
  const stuck = prepare({ skipStrip: true });
  assert.equal(stuck.result.status, 1);
  assert.match(stuck.result.stderr, /still has ACL entries that allow access/);
  assert.doesNotMatch(stuck.result.stdout, /PREPARED/);
  const open = prepare({ otherCanOpen: true });
  assert.equal(open.result.status, 1);
  assert.match(open.result.stderr, /admin-test can still open/);
});

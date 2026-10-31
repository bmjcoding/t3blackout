#!/usr/bin/env bash
# Sets up a macOS account that coding agents run in, reached from a T3 Blackout
# desktop over SSH (docs/two-mac-setup.md). Run once per account, with sudo, from
# the admin account that ran install.sh; rerun it any time, it puts everything
# back the way it describes:
#
#   sudo scripts/add-agent-account.sh agent-claude                         # on the always-on host
#   sudo scripts/add-agent-account.sh agent-standby --loopback-only        # the desktop Mac's standby lane
#
# It creates a standard (non-admin) account if needed (macOS asks for its
# password) and locks its home, and yours, to their owners. The account logs in
# over SSH with your key only: root keeps the key in
# /etc/ssh/t3blackout/authorized_keys/<account>, where the account can't add its
# own. Every account logs in with keys only, never a password, and only agent
# accounts may log in over SSH at all.
#   - Without --loopback-only, macOS's Remote Login is the listener (turn it on
#     in System Settings; key-only SSH on your network).
#   - With --loopback-only, a separate sshd (launchd job dev.t3blackout.sshd)
#     listens on 127.0.0.1 and ::1 port 2222 only, for this Mac's own desktop;
#     Remote Login stays off (its launchd socket can't be bound to loopback).
# The app comes from /Applications (install.sh). Provider logins happen inside
# the account afterwards, with /usr/local/libexec/t3blackout/set-claude-token.
#
# Options:
#   --key FILE        public key to authorize (default: the first key your SSH agent
#                     offers, e.g. 1Password's)
#   --loopback-only   reached from this Mac only, through the separate loopback sshd

set -euo pipefail

APP="/Applications/T3 Blackout.app"
AGENT_GROUP=t3blackout-agents
# Remote Login's "Only these users" list; PAM (pam_sacl) checks it for every sshd.
SSH_ACCESS_GROUP=com.apple.access_ssh
SSH_DIR=/etc/ssh/t3blackout
KEYS_DIR=$SSH_DIR/authorized_keys
# Before macOS's 100-macos.conf: sshd keeps the first value it reads.
DROPIN=/etc/ssh/sshd_config.d/010-t3blackout.conf
LOOPBACK_LABEL=dev.t3blackout.sshd
LOOPBACK_PORT=2222
LOOPBACK_CONFIG=$SSH_DIR/sshd_config
LOOPBACK_HOSTKEY=$SSH_DIR/ssh_host_ed25519_key
LOOPBACK_PLIST=/Library/LaunchDaemons/$LOOPBACK_LABEL.plist
HELPER_DIR=/usr/local/libexec/t3blackout
HELPER=$HELPER_DIR/set-claude-token
SHARED_RATES=/Users/Shared/t3blackout/usage-model-rates.json
KEY_RE='^(ssh-ed25519|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh\.com|ssh-rsa) [A-Za-z0-9+/]+=*( .*)?$'

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Runs a command as `user`, never as root: inside an account's home, root would
# follow whatever symlinks that account planted there.
as_user() {
  local user="$1"
  shift
  sudo -u "$user" -H -- "$@"
}

home_of() { dscl . -read "/Users/$1" NFSHomeDirectory | awk '{print $2}'; }
is_agent() { dseditgroup -o checkmember -m "$1" "$AGENT_GROUP" >/dev/null 2>&1; }
# A group attribute's values (user names, GUIDs), or nothing when it has none.
group_values() { { dscl . -read "/Groups/$1" "$2" 2>/dev/null || true; } | sed "1s/^$2://"; }

# ----------------------------------------------------------------- configs --

# Remote Login's sshd (and any other reading /etc/ssh/sshd_config): keys only for
# everyone; agent accounts get the root-owned keys and only what T3 Blackout's
# SSH environments use (a shell, and forwards to this Mac's loopback). sshd ends
# a Match block at the end of an included file, so macOS's settings after it stay
# global.
render_dropin() {
  cat <<EOF
# Written by t3blackout scripts/add-agent-account.sh; rewritten on each run.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
Match Group $AGENT_GROUP
  AuthorizedKeysFile $KEYS_DIR/%u
  AuthenticationMethods publickey
  AllowTcpForwarding local
  PermitOpen 127.0.0.1:* localhost:* [::1]:*
  AllowAgentForwarding no
  AllowStreamLocalForwarding no
  X11Forwarding no
  PermitTunnel no
  GatewayPorts no
  PermitUserRC no
EOF
}

# The standby lane's own sshd, run by launchd as `sshd -D -f`: it binds its own
# sockets, so ListenAddress holds (unlike Remote Login, whose socket launchd owns).
render_loopback_config() {
  cat <<EOF
# Written by t3blackout scripts/add-agent-account.sh; rewritten on each run.
# The standby lane's sshd (launchd job $LOOPBACK_LABEL): this Mac's loopback
# only, agent accounts only, keys only.
Port $LOOPBACK_PORT
ListenAddress 127.0.0.1
ListenAddress ::1
HostKey $LOOPBACK_HOSTKEY
PidFile /var/run/$LOOPBACK_LABEL.pid
UsePAM yes
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowGroups $AGENT_GROUP
AuthorizedKeysFile $KEYS_DIR/%u
StrictModes yes
UseDNS no
PermitUserEnvironment no
AllowTcpForwarding local
PermitOpen 127.0.0.1:* localhost:* [::1]:*
AllowAgentForwarding no
AllowStreamLocalForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
PermitUserRC no
AcceptEnv LANG LC_*
EOF
  # macOS's own sshd settings take its crypto policy from here.
  if [[ -e /etc/ssh/crypto.conf ]]; then echo "Include /etc/ssh/crypto.conf"; fi
}

render_loopback_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LOOPBACK_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/sbin/sshd</string>
    <string>-D</string>
    <string>-f</string>
    <string>$LOOPBACK_CONFIG</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/var/log/$LOOPBACK_LABEL.log</string>
</dict>
</plist>
EOF
}

# ------------------------------------------------------------------- steps --

# Your key, from 1Password's agent socket (set in ~/.ssh/config, not
# SSH_AUTH_SOCK), the invoking shell's agent, or your login session's: the first
# that offers a key.
find_agent_key() {
  local session_sock
  session_sock="$(launchctl asuser "$(id -u "$SUDO_USER")" launchctl getenv SSH_AUTH_SOCK 2>/dev/null || true)"
  # shellcheck disable=SC2016 # expanded by the inner bash
  as_user "$SUDO_USER" /bin/bash -c '
    re="$1"; shift
    for sock in "$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" "$@"; do
      [[ -n "$sock" && -S "$sock" ]] || continue
      keys="$(SSH_AUTH_SOCK="$sock" ssh-add -L 2>/dev/null)" || continue
      while IFS= read -r key; do
        if [[ "$key" =~ $re ]]; then printf "%s\n" "$key"; exit 0; fi
      done <<<"$keys"
    done
    exit 1' bash "$KEY_RE" "${SSH_AUTH_SOCK:-}" "$session_sock"
}

ensure_account() {
  if id "$NAME" >/dev/null 2>&1; then
    say "Account $NAME exists"
  else
    say "Creating standard account $NAME (macOS asks for its password)"
    sysadminctl -addUser "$NAME" -fullName "T3 agents ($NAME)" -password - -home "/Users/$NAME"
    createhomedir -c -u "$NAME" >/dev/null
  fi
  if dseditgroup -o checkmember -m "$NAME" admin >/dev/null 2>&1; then die "$NAME is an admin; agent accounts must be standard accounts"; fi
  (($(id -u "$NAME") >= 501)) || die "$NAME is a system account; agent accounts are ordinary ones"
  HOME_DIR="$(home_of "$NAME")"
  [[ "$HOME_DIR" == "/Users/$NAME" ]] || die "$NAME's home is $HOME_DIR; agent accounts need /Users/$NAME"
  [[ -d "$HOME_DIR" && ! -L "$HOME_DIR" ]] || die "$HOME_DIR isn't a folder"
  [[ "$(stat -f '%u' "$HOME_DIR")" == "$(id -u "$NAME")" ]] || die "$HOME_DIR doesn't belong to $NAME"
}

# macOS homes are group-readable (0750) by staff, and agent accounts are in staff
# like you: without this, an agent could read your home and your clone in it.
make_admin_home_private() {
  local mode
  mode="$(stat -f '%Lp' "$ADMIN_HOME")"
  if (((8#$mode) & 8#077)); then
    say "Making $ADMIN_HOME private (chmod go-rwx): agent accounts share your staff group"
    as_user "$SUDO_USER" /bin/chmod go-rwx "$ADMIN_HOME"
  fi
  if as_user "$NAME" /bin/test -r "$ADMIN_HOME" || as_user "$NAME" /bin/test -x "$ADMIN_HOME"; then
    die "$NAME can still open $ADMIN_HOME, probably through an ACL entry; see: ls -led '$ADMIN_HOME'"
  fi
}

join_agent_group() {
  if ! dscl . -read "/Groups/$AGENT_GROUP" >/dev/null 2>&1; then
    dseditgroup -o create -r "T3 Blackout agent accounts" "$AGENT_GROUP"
  fi
  dseditgroup -o edit -a "$NAME" -t user "$AGENT_GROUP"
  dsmemberutil flushcache
}

# Root-owned, outside every agent's home, and rewritten whole: exactly the key
# this run authorizes. An earlier key (unrestricted, or another one) is gone, and
# keys of accounts no longer in the agent group are removed.
write_authorized_keys() {
  local dir tmp file user
  for dir in "$SSH_DIR" "$KEYS_DIR"; do
    [[ -L "$dir" ]] && die "$dir is a symlink; remove it and rerun"
    install -d -o root -g wheel -m 755 "$dir"
  done
  tmp="$(mktemp "$KEYS_DIR/.$NAME.XXXXXX")"
  printf '%s\n' "$LINE" >"$tmp"
  chown root:wheel "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$KEYS_DIR/$NAME"
  for file in "$KEYS_DIR"/*; do
    [[ -e "$file" ]] || continue
    user="$(basename "$file")"
    if ! is_agent "$user"; then
      rm -f "$file"
      say "Removed the SSH key of $user, which isn't in $AGENT_GROUP"
    fi
  done
}

# The pricing table cost estimates read: the one the updater published, else
# yours. The server copies newer ones itself (lib/files/ssh-runner-blackout.sh).
seed_pricing() {
  local candidate src=""
  for candidate in "$SHARED_RATES" "$ADMIN_HOME/.t3blackout/userdata/usage-model-rates.json"; do
    if [[ -f "$candidate" && ! -L "$candidate" && "$(stat -f '%u' "$candidate")" == "$(id -u "$SUDO_USER")" ]]; then
      src="$candidate"
      break
    fi
  done
  if [[ -z "$src" ]]; then
    say "No pricing table to copy yet; $NAME's server copies the one the next update publishes"
    return 0
  fi
  # shellcheck disable=SC2016 # expanded by the inner sh
  as_user "$NAME" /bin/sh -c 'umask 077 && mkdir -p "$1" && cat >"$1/usage-model-rates.json.new" && mv -f "$1/usage-model-rates.json.new" "$1/usage-model-rates.json"' \
    sh "$HOME_DIR/.t3blackout/userdata" <"$src"
}

# The home's own ACL entries go too, as the account (its owner): mode 0700
# doesn't show or stop them, and an entry like "everyone allow list,search"
# would let other accounts into it. Only macOS's usual guard against deleting a
# home is put back. Then it's checked from your account, as for your home.
prepare_agent_home() {
  say "Locking $HOME_DIR to $NAME (mode 700, no ACL entries but macOS's deny delete)"
  as_user "$NAME" /bin/chmod -N "$HOME_DIR"
  as_user "$NAME" /bin/chmod +a "group:everyone deny delete" "$HOME_DIR"
  as_user "$NAME" /bin/chmod 700 "$HOME_DIR"
  if /bin/ls -led "$HOME_DIR" | grep -Eq '^ *[0-9]+: .* allow '; then
    die "$HOME_DIR still has ACL entries that allow access; see: ls -led '$HOME_DIR'"
  fi
  if as_user "$SUDO_USER" /bin/test -r "$HOME_DIR" || as_user "$SUDO_USER" /bin/test -x "$HOME_DIR"; then
    die "$SUDO_USER can still open $HOME_DIR; see: ls -led '$HOME_DIR'"
  fi
  say "Preparing $HOME_DIR/.t3blackout (owner only, no ACL entries)"
  # shellcheck disable=SC2016 # expanded by the inner sh
  as_user "$NAME" /bin/sh -c 'umask 077 && mkdir -p "$1" && chmod 700 "$1" && chmod -N "$1"' sh "$HOME_DIR/.t3blackout"
  seed_pricing
}

# Agent accounts can't open your home (or the clone in it), so they run a
# root-owned copy of the token helper.
install_token_helper() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [[ -d /usr/local ]] || install -d -o root -g wheel -m 755 /usr/local
  [[ -d /usr/local/libexec ]] || install -d -o root -g wheel -m 755 /usr/local/libexec
  [[ -L "$HELPER_DIR" ]] && die "$HELPER_DIR is a symlink; remove it and rerun"
  install -d -o root -g wheel -m 755 "$HELPER_DIR"
  install -o root -g wheel -m 755 "$here/set-claude-token.sh" "$HELPER"
}

# Remote Login's access list holds exactly the agent accounts: not you, nor anyone
# added through System Settings ("Administrators" included).
reconcile_ssh_access() {
  local member guid removed=""
  if ! dscl . -read "/Groups/$SSH_ACCESS_GROUP" >/dev/null 2>&1; then dseditgroup -o create -q "$SSH_ACCESS_GROUP"; fi
  for member in $(group_values "$AGENT_GROUP" GroupMembership); do
    dseditgroup -o edit -a "$member" -t user "$SSH_ACCESS_GROUP"
  done
  for member in $(group_values "$SSH_ACCESS_GROUP" GroupMembership); do
    is_agent "$member" && continue
    dseditgroup -o edit -d "$member" -t user "$SSH_ACCESS_GROUP"
    removed="$removed $member"
  done
  for guid in $(group_values "$SSH_ACCESS_GROUP" NestedGroups); do
    dscl . -delete "/Groups/$SSH_ACCESS_GROUP" NestedGroups "$guid"
    removed="$removed group:$guid"
  done
  dsmemberutil flushcache
  if [[ -n "$removed" ]]; then say "Removed from Remote Login's access list:$removed"; fi
  say "SSH logins allowed for: $(group_values "$SSH_ACCESS_GROUP" GroupMembership | xargs)"
}

# sshd -t needs host keys, which macOS makes the first time Remote Login starts;
# on a fresh Mac there are none yet. ssh-keygen -A makes the missing ones, as
# macOS would.
ensure_host_keys() {
  ssh-keygen -A >/dev/null
}

# Validated in place (sshd reads every file in sshd_config.d), with the previous
# version put back if sshd rejects the new one: never a config that stops
# Remote Login starting.
install_dropin() {
  local new backup="" out
  new="$(mktemp /etc/ssh/.t3blackout-dropin.XXXXXX)"
  render_dropin >"$new"
  chmod 644 "$new"
  if [[ -f "$DROPIN" ]]; then
    backup="$(mktemp /etc/ssh/.t3blackout-dropin-old.XXXXXX)"
    cp -p "$DROPIN" "$backup"
  fi
  mv -f "$new" "$DROPIN"
  if out="$(/usr/sbin/sshd -t 2>&1)"; then
    rm -f "$backup"
    return 0
  fi
  if [[ -n "$backup" ]]; then mv -f "$backup" "$DROPIN"; else rm -f "$DROPIN"; fi
  if grep -q 'no hostkeys available' <<<"$out"; then die "sshd has no host keys it can use (ssh-keygen -A didn't make them): $out"; fi
  die "sshd rejected the new $DROPIN, so the previous one is back in place: $out"
}

verify_loopback_listener() {
  local i listeners address
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if nc -z -G 1 127.0.0.1 "$LOOPBACK_PORT" >/dev/null 2>&1; then break; fi
    [[ $i == 10 ]] || sleep 0.5
  done
  listeners="$(lsof -nP -a -c sshd -iTCP:"$LOOPBACK_PORT" -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n//p' | sort -u || true)"
  [[ -n "$listeners" ]] || die "the standby sshd isn't listening on port $LOOPBACK_PORT; see /var/log/$LOOPBACK_LABEL.log"
  while IFS= read -r address; do
    case "$address" in
      "127.0.0.1:$LOOPBACK_PORT" | "[::1]:$LOOPBACK_PORT") ;;
      *) die "port $LOOPBACK_PORT is open on $address, not just loopback; stop it: sudo launchctl bootout system/$LOOPBACK_LABEL" ;;
    esac
  done <<<"$listeners"
}

install_loopback_sshd() {
  local config plist out
  say "Standby sshd: 127.0.0.1 and ::1 port $LOOPBACK_PORT only (launchd job $LOOPBACK_LABEL)"
  [[ -f "$LOOPBACK_HOSTKEY" ]] || ssh-keygen -q -t ed25519 -N '' -C t3blackout-standby -f "$LOOPBACK_HOSTKEY"
  config="$(mktemp "$SSH_DIR/.sshd_config.XXXXXX")"
  render_loopback_config >"$config"
  chmod 644 "$config"
  if ! out="$(/usr/sbin/sshd -t -f "$config" 2>&1)"; then
    rm -f "$config"
    die "sshd rejected the standby config: $out"
  fi
  mv -f "$config" "$LOOPBACK_CONFIG"
  plist="$(mktemp /Library/LaunchDaemons/.t3blackout-sshd.XXXXXX)"
  render_loopback_plist >"$plist"
  if ! plutil -lint -s "$plist"; then
    rm -f "$plist"
    die "the standby sshd's launchd job didn't validate"
  fi
  chown root:wheel "$plist"
  chmod 644 "$plist"
  mv -f "$plist" "$LOOPBACK_PLIST"
  launchctl bootout "system/$LOOPBACK_LABEL" >/dev/null 2>&1 || true
  launchctl enable "system/$LOOPBACK_LABEL"
  launchctl bootstrap system "$LOOPBACK_PLIST"
  verify_loopback_listener
}

# The desktop connects with BatchMode, so it can't accept an unknown host key:
# record this sshd's key for you, replacing any older one for these addresses.
trust_loopback_host_key() {
  local key
  key="$(cut -d' ' -f1,2 "$LOOPBACK_HOSTKEY.pub")"
  # shellcheck disable=SC2016 # expanded by the inner sh
  as_user "$SUDO_USER" /bin/sh -c '
    umask 077
    mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/known_hosts"
    for host in "[127.0.0.1]:$1" "[localhost]:$1" "[::1]:$1"; do
      ssh-keygen -q -R "$host" -f "$HOME/.ssh/known_hosts" >/dev/null 2>&1 || true
    done
    printf "%s %s\n" "[127.0.0.1]:$1,[localhost]:$1,[::1]:$1" "$2" >>"$HOME/.ssh/known_hosts"' sh "$LOOPBACK_PORT" "$key"
  say "Your known_hosts now trusts the standby sshd's key ($(ssh-keygen -l -f "$LOOPBACK_HOSTKEY.pub" | awk '{print $2}'))"
}

# --------------------------------------------------------------------- main --

main() {
  [[ "$(uname -s)" == Darwin ]] || die "macOS only"
  [[ $EUID -eq 0 ]] || die "run with sudo: sudo $0 $*"
  [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]] || die "run with sudo from your admin account, not as root"

  NAME="${1:-}"
  shift || true
  [[ "$NAME" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "usage: sudo $0 <account-name> [--loopback-only] [--key FILE]"
  [[ "$NAME" != "$SUDO_USER" ]] || die "the agent account must be a separate account, not yours"
  LOOPBACK=0
  KEY_FILE=""
  while (($#)); do
    case "$1" in
      --loopback-only) LOOPBACK=1; shift ;;
      --key) KEY_FILE="${2:-}"; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done

  [[ -x "$APP/Contents/MacOS/T3 Blackout" ]] ||
    die "$APP is missing; run ./install.sh --role host (or both) as an admin first"
  ADMIN_HOME="$(home_of "$SUDO_USER")"

  # The key that may log in: yours, from a file or your SSH agent (never generated here).
  if [[ -n "$KEY_FILE" ]]; then
    KEY="$(head -n 1 "$KEY_FILE")"
  else
    KEY="$(find_agent_key || true)"
  fi
  if ! [[ "$KEY" =~ $KEY_RE ]] || ! ssh-keygen -l -f - <<<"$KEY" >/dev/null 2>&1; then
    die "no SSH public key found; unlock 1Password (its SSH agent) or pass --key ~/.ssh/id_ed25519.pub"
  fi
  LINE="$KEY"
  if ((LOOPBACK)); then LINE="from=\"127.0.0.1,::1\" $KEY"; fi

  ensure_account
  make_admin_home_private
  join_agent_group
  say "Authorizing your key for $NAME in $KEYS_DIR/$NAME (root-owned)"
  write_authorized_keys
  prepare_agent_home
  install_token_helper
  reconcile_ssh_access
  ensure_host_keys
  say "sshd: keys only; agent accounts use $KEYS_DIR"
  install_dropin

  local target
  if ((LOOPBACK)); then
    install_loopback_sshd
    trust_loopback_host_key
    if nc -z -G 2 127.0.0.1 22 >/dev/null 2>&1; then
      warn "Remote Login is on. The standby lane doesn't use it; unless you need it, turn it off: System Settings > General > Sharing > Remote Login."
    fi
    target="host 127.0.0.1, port $LOOPBACK_PORT, user $NAME"
  else
    if ! nc -z -G 2 127.0.0.1 22 >/dev/null 2>&1; then
      cat <<'NEXT'

Turn on Remote Login: System Settings > General > Sharing > Remote Login, with
"Allow access for: Only these users" and "Allow full disk access for remote
users" off. Then run this script again: turning Remote Login on can change that
list, and each run sets it back to exactly the agent accounts.
NEXT
    fi
    target="$NAME@<this Mac>"
  fi

  cat <<NEXT

Done. Next, as $NAME (ssh $( ((LOOPBACK)) && echo "-p $LOOPBACK_PORT ")$NAME@localhost, or log in at the screen):
  1. Install the provider CLIs it should run (Claude Code, Codex, ...) on its own PATH
     (docs/two-mac-setup.md, section 3.5).
  2. codex login                       (Codex keeps its login in a file)
  3. claude setup-token                (SSH sessions can't unlock the Keychain)
  4. $HELPER   (stores it, owner only)
Then in T3 Blackout: Settings > Connections > Environments > Add environment > SSH: $target.
NEXT
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi

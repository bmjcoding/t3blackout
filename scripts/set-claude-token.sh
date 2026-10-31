#!/usr/bin/env bash
# Stores a Claude Code token (from `claude setup-token`) for the T3 Blackout
# server in this account, in ~/.t3blackout/server.env (owner only), which the
# SSH runner loads (lib/files/ssh-runner-blackout.sh). SSH sessions can't unlock
# the login Keychain, where Claude Code keeps its usual login.
#
# Run as the agent account. scripts/add-agent-account.sh installs a root-owned
# copy every account can run: /usr/local/libexec/t3blackout/set-claude-token
# The token is read from a hidden prompt, never from arguments or the environment.

set -euo pipefail

T3B_HOME="$HOME/.t3blackout"
ENV_FILE="$T3B_HOME/server.env"
umask 077
[[ -L "$T3B_HOME" || -L "$ENV_FILE" ]] && { printf '%s or %s is a symlink; remove it and run this again.\n' "$T3B_HOME" "$ENV_FILE" >&2; exit 1; }
mkdir -p "$T3B_HOME"
chmod 700 "$T3B_HOME"
# Owner only means no ACL entries either (mode bits don't show them).
if [[ "$(uname -s)" == Darwin ]]; then chmod -N "$T3B_HOME"; fi

printf 'Paste the token from `claude setup-token` (input hidden): '
IFS= read -rs TOKEN
printf '\n'
[[ "$TOKEN" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]] || { printf 'That does not look like a Claude Code token.\n' >&2; exit 1; }

TMP="$(mktemp "$ENV_FILE.XXXXXX")"
# An interrupted run must not leave a token-bearing copy behind.
trap 'rm -f "$TMP"' EXIT
trap 'exit 130' INT TERM HUP
if [[ -f "$ENV_FILE" ]]; then grep -v '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" >"$TMP" || true; fi
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$TOKEN" >>"$TMP"
unset TOKEN
chmod 600 "$TMP"
if [[ "$(uname -s)" == Darwin ]]; then chmod -N "$TMP"; fi
mv "$TMP" "$ENV_FILE"
trap - EXIT
printf 'Saved to %s (owner only). To use it, switch this account'\''s SSH environment off and on in T3 Blackout\n(Settings > Connections > Environments).\n' "$ENV_FILE"

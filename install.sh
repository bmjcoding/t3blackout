#!/usr/bin/env bash
# T3 Blackout installer. Safe to rerun: every step checks before acting.
#
#   ./install.sh                       # vault "Personal", daily update at 04:00
#   T3BLACKOUT_VAULT=Other T3BLACKOUT_UPDATE_HOUR=6 ./install.sh
#
# Installs missing build tools with Homebrew, sets up the shared signing
# certificate from 1Password (creating it if this is the first Mac), builds and
# installs T3 Blackout, and schedules the daily update.

set -euo pipefail
cd "$(dirname "$0")"

VAULT="${T3BLACKOUT_VAULT:-Personal}"
HOUR="${T3BLACKOUT_UPDATE_HOUR:-4}"
OP_ITEM="T3 Blackout code signing"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- platform ------------------------------------------------------------------
case "$(uname -s)" in
  Darwin) ;;
  Linux) die "Linux isn't supported yet: the egress sandbox, scheduler and signing are macOS-specific (Seatbelt, launchd, Keychain)." ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac
[[ "$(uname -m)" == arm64 ]] || die "Apple silicon only; builds target arm64."

# --- toolchain -----------------------------------------------------------------
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install >/dev/null 2>&1 || true
  die "Install the Xcode Command Line Tools (a dialog should have opened), then rerun ./install.sh"
fi

if ! command -v brew >/dev/null 2>&1; then
  [[ -x /opt/homebrew/bin/brew ]] || die "Homebrew is required (https://brew.sh). Install it, then rerun ./install.sh"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

missing=()
command -v git >/dev/null 2>&1 || missing+=(git)
command -v node >/dev/null 2>&1 || missing+=(node)
command -v pnpm >/dev/null 2>&1 || missing+=(pnpm)
command -v cargo >/dev/null 2>&1 || missing+=(rust)
if ((${#missing[@]})); then
  say "Installing ${missing[*]} with Homebrew"
  brew install "${missing[@]}"
fi
if ! command -v op >/dev/null 2>&1; then
  say "Installing the 1Password CLI"
  brew install --cask 1password-cli
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
((node_major >= 24)) || die "Node 24 or newer is required (found $(node --version))."

# --- signing certificate (1Password) -------------------------------------------
if bin/t3blackout signing status | grep -q "not set up"; then
  [[ -d /Applications/1Password.app ]] || die "Install the 1Password app and sign in, then rerun ./install.sh"
  if ! op vault list >/dev/null 2>&1; then
    die "Turn on 1Password → Settings → Developer → \"Integrate with 1Password CLI\", then rerun ./install.sh"
  fi
  if op item get "$OP_ITEM" --vault "$VAULT" >/dev/null 2>&1; then
    say "Importing the shared signing certificate from 1Password ($VAULT)"
    bin/t3blackout signing import --vault "$VAULT"
  else
    say "No signing certificate in 1Password yet; creating one in \"$VAULT\""
    bin/t3blackout signing init --vault "$VAULT"
  fi
else
  say "Signing certificate already set up"
fi

# --- build, install, schedule --------------------------------------------------
say "Building and installing T3 Blackout (a few minutes on first run)"
bin/t3blackout update

say "Scheduling the daily update at ${HOUR}:00"
bin/t3blackout schedule --hour "$HOUR"

say "Done"
bin/t3blackout status
cat <<'EOF'

Open "T3 Blackout" from ~/Applications (or the Dock), or run: bin/t3blackout launch
Blocked hosts:  bin/t3blackout denials    Allowlist: egress/allowlist.txt
EOF

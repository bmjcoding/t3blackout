#!/usr/bin/env bash
# T3 Blackout installer for macOS and Linux. Safe to rerun: every step checks
# before acting.
#
#   ./install.sh [--role ui|host|both]   # hourly update check (macOS: vault "Personal")
#   T3BLACKOUT_UPDATE_DAY=daily T3BLACKOUT_UPDATE_HOUR=6 T3BLACKOUT_VAULT=Other ./install.sh
#
# Run it as yourself, not with sudo: it asks for sudo for the steps that need it.
#
# Roles (docs/two-mac-setup.md):
#   ui    (default) the desktop app you work in.
#   host  macOS only. Agents run here in their own accounts, reached over SSH;
#         the app is installed for them in /Applications and not opened, and the
#         update check runs as a LaunchDaemon (as you), so it keeps running with
#         nobody logged in. Then add each account, e.g.:
#         sudo scripts/add-agent-account.sh agent-claude --key ~/.ssh/t3blackout.pub
#   both  macOS only. The desktop app plus an agent account on this machine (a
#         standby lane), e.g.:
#         sudo scripts/add-agent-account.sh agent-standby --loopback-only --key ~/.ssh/t3blackout.pub
#
# macOS: installs missing tools with Homebrew, sets up the shared signing
#   identity from 1Password (from your Apple Development certificate on the
#   first Mac), builds, installs.
# Linux (Omarchy/Arch, Ubuntu/Debian, Fedora/RHEL): installs system packages
#   with the distro package manager and Node 24 into your home directory, then
#   builds and installs. No signing step: Linux keyrings don't tie access to an
#   app's signature.
# Both: creates a separate, unprivileged build account (_t3blackout) so the
#   scheduled build's dependency and build scripts can't read your home (which
#   it makes private if they could). pnpm and, on Linux, rustup are pinned
#   versions checked against the digests below. Needs sudo once; without it,
#   builds run as you.

set -euo pipefail
cd "$(dirname "$0")"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
# Builds as root would run upstream's dependency and build scripts as root, and
# leave root-owned files your own runs can't update.
((EUID != 0)) || die "run ./install.sh as yourself, not as root or with sudo; it asks for sudo when it needs it"

ROLE=ui
while (($#)); do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --role=*) ROLE="${1#--role=}"; shift ;;
    *) printf 'usage: ./install.sh [--role ui|host|both]\n' >&2; exit 2 ;;
  esac
done
case "$ROLE" in ui | host | both) ;; *) printf 'unknown role: %s (ui, host or both)\n' "$ROLE" >&2; exit 2 ;; esac
# Agent accounts, the shared /Applications install and host updates are macOS's.
[[ "$ROLE" == ui || "$(uname -s)" == Darwin ]] || die "--role $ROLE is macOS only; on Linux, install with --role ui"

HOUR="${T3BLACKOUT_UPDATE_HOUR:-4}"
# Hourly: with pin.json a run builds only when the pin moved (security fixes within the hour).
DAY="${T3BLACKOUT_UPDATE_DAY:-hourly}"
VAULT="${T3BLACKOUT_VAULT:-Personal}"
OP_ITEM="T3 Blackout code signing"
NODE_MAJOR=24

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
# The oldest patched release on each line Node supports (Oct 2026 security release:
# Brotli RCE CVE-2026-111497 and TLS hostname bypasses). Raise when Node ships a new one.
NODE_PATCHED='{"22":"22.23.4","24":"24.22.1","26":"26.12.1"}'
NODE_CHECK='
  const [maj, min, pat] = process.versions.node.split(".").map(Number);
  const floor = JSON.parse(process.argv[1])[maj];
  const [fmaj, fmin, fpat] = (floor ?? "0.0.0").split(".").map(Number);
  const patched = floor ? (min > fmin || (min === fmin && pat >= fpat)) : maj > 26;
  process.exit(maj >= Number(process.argv[2]) && patched ? 0 : 1);
'
# Whether node ($1, default the one on PATH) is Node $NODE_MAJOR+ with the security floor.
# shellcheck disable=SC2120 # $1 is for tests; the script itself checks the node on PATH
node_ok() {
  local node="${1:-node}"
  have "$node" && "$node" -e "$NODE_CHECK" "$NODE_PATCHED" "$NODE_MAJOR"
}

# git 2.45+: mirror reads pass --no-lazy-fetch (lib/util.mjs), new in 2.45.0.
GIT_MIN=2.45
git_ok() {
  have git || return 1
  local v
  v=$(git --version | sed -E 's/^git version ([0-9]+)\.([0-9]+).*/\1 \2/')
  read -r maj min <<<"$v"
  [[ "$maj" =~ ^[0-9]+$ && "$min" =~ ^[0-9]+$ ]] || return 1
  ((maj > 2 || (maj == 2 && min >= 45)))
}

# Bootstrap tools outside any package manager's age gate, pinned and checked
# against these digests (raise them deliberately, and only to releases at least
# 3 days old). pnpm matches upstream's packageManager; its wrapper package
# carries node-gyp, and the native build for each platform replaces the
# wrapper's placeholder, which is what pnpm's own install script does.
PNPM_VERSION=12.14.0
pnpm_sha512() {
  case "$1" in
    wrapper) echo c18ba6d87993d3d164cb5e8948f32b2c06ee854487e06cd8d86781342fb3e5bb4634367034711e86802baa9c37bea906ce1929ad08d70884c97d801df13389a6 ;;
    darwin-arm64) echo b67add501f1e709a1e86e28aaa2d581c205597ad71b49f57546731e44be20ba7d63b80de188f06b57ae3bc9c4304cde7b958c97968acb60b14a7f375e36c78b3 ;;
    darwin-x64) echo be505f1a4aeea9046c1074d6e3770fc2961ded095b209fff72fa4075bddb557908f128133e85e10a7734e66f993623ebac4901b17fedeca1f0f5a5e99333e6dd ;;
    linux-x64) echo 17a2bc7bf8d6c62b84609690b514541bdca70524c41dafadecb7fce8c2ae38ee5403b59554c6e2fa807c9d8ea2296fbe9dc592db21ba4fd7da5d91b1a8db1fa1 ;;
    linux-arm64) echo ee3a064a1678e0d9375a9354fbad09a0e3e3097960c61240ab5d52d94895b700940e04deaf5c933cf7f1196f29c5a0fad38e9a72d60b2180db64d96e6c75acd0 ;;
    *) die "no pinned pnpm for $1" ;;
  esac
}
# rustup-init (Linux; macOS takes Rust from Homebrew) and the toolchain it installs.
RUSTUP_VERSION=1.29.2
RUST_TOOLCHAIN=1.99.1
rustup_sha256() {
  case "$1" in
    x86_64-unknown-linux-gnu) echo 5be191e8c70a5007074254cb74d78dbfdd25cd5a61c27de7b8e5410122ec24f4 ;;
    aarch64-unknown-linux-gnu) echo a9c168dbea81a84671c6b7a5c1795cb0eb699020110d107ddfca427bd797e697 ;;
    *) die "no pinned rustup for $1" ;;
  esac
}

# Downloads $1 to $3 and checks its SHA-$4 (256 or 512) is $2.
fetch_pinned() {
  local url="$1" want="$2" out="$3" bits="$4" got
  curl --proto '=https' --tlsv1.2 -fsSL -o "$out" "$url"
  if have "sha${bits}sum"; then got="$("sha${bits}sum" "$out")"; else got="$(shasum -a "$bits" "$out")"; fi
  [[ "${got%% *}" == "$want" ]] || die "$url doesn't match its pinned SHA-$bits digest"
}

# Installs pinned pnpm under prefix $1 (bin/ and lib/node_modules/, as npm -g
# would), with no install scripts run. The rest ($2...) is how to run as the
# account it's for (as_builder), or nothing for you.
install_pnpm() {
  local prefix="$1" target tmp bin
  shift
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=darwin-arm64 ;;
    Darwin-x86_64) target=darwin-x64 ;;
    Linux-x86_64) target=linux-x64 ;;
    Linux-aarch64 | Linux-arm64) target=linux-arm64 ;;
    *) die "no pinned pnpm for $(uname -sm)" ;;
  esac
  if [[ "$target" == linux-* ]] && ldd --version 2>&1 | grep -qi musl; then die "no pinned pnpm for musl Linux"; fi
  say "Installing pnpm $PNPM_VERSION into $prefix"
  tmp="$(mktemp -d)"
  fetch_pinned "https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_VERSION.tgz" "$(pnpm_sha512 wrapper)" "$tmp/wrapper.tgz" 512
  fetch_pinned "https://registry.npmjs.org/@pnpm/exe.$target/-/exe.$target-$PNPM_VERSION.tgz" "$(pnpm_sha512 "$target")" "$tmp/exe.tgz" 512
  mkdir "$tmp/pnpm" "$tmp/exe"
  tar -xzf "$tmp/wrapper.tgz" -C "$tmp/pnpm" --strip-components 1
  tar -xzf "$tmp/exe.tgz" -C "$tmp/exe" --strip-components 1
  for bin in pnpm pn pnpx pnx; do
    cp "$tmp/exe/pnpm" "$tmp/pnpm/$bin"
    chmod 755 "$tmp/pnpm/$bin"
  done
  # shellcheck disable=SC2016 # expanded by the inner sh
  tar -C "$tmp" -cf - pnpm | "$@" /bin/sh -c '
    set -e
    mkdir -p "$1/lib/node_modules" "$1/bin"
    rm -rf "$1/lib/node_modules/pnpm"
    tar -C "$1/lib/node_modules" -xf -
    for bin in pnpm pn pnpx pnx; do ln -sfn "../lib/node_modules/pnpm/$bin" "$1/bin/$bin"; done' sh "$prefix"
  rm -rf "$tmp"
  [[ "$("$@" "$prefix/bin/pnpm" --version)" == "$PNPM_VERSION" ]] || die "pnpm $PNPM_VERSION didn't install into $prefix"
}

# Installs Rust $RUST_TOOLCHAIN with pinned rustup-init (Linux), as the account
# $1... (as_builder), or as you with no arguments.
install_rust() {
  local triple tmp
  case "$(uname -m)" in
    x86_64) triple=x86_64-unknown-linux-gnu ;;
    aarch64 | arm64) triple=aarch64-unknown-linux-gnu ;;
    *) die "no pinned rustup for $(uname -m)" ;;
  esac
  say "Installing Rust $RUST_TOOLCHAIN (rustup $RUSTUP_VERSION, minimal profile)"
  tmp="$(mktemp -d)"
  fetch_pinned "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$triple/rustup-init" "$(rustup_sha256 "$triple")" "$tmp/rustup-init" 256
  # shellcheck disable=SC2016 # expanded by the inner sh
  "$@" /bin/sh -c 'set -e; f="$(mktemp)"; trap "rm -f \"$f\"" EXIT; cat >"$f"; chmod 700 "$f"
    "$f" -y --profile minimal --no-modify-path --default-toolchain "$1" >/dev/null' sh "$RUST_TOOLCHAIN" <"$tmp/rustup-init"
  rm -rf "$tmp"
}

# --- macOS ----------------------------------------------------------------------
mac_setup() {
  if ! xcode-select -p >/dev/null 2>&1; then
    xcode-select --install >/dev/null 2>&1 || true
    die "Install the Xcode Command Line Tools (a dialog should have opened), then rerun ./install.sh"
  fi
  if ! have brew; then
    [[ -x /opt/homebrew/bin/brew ]] || die "Homebrew is required (https://brew.sh). Install it, then rerun ./install.sh"
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi

  local missing=()
  git_ok || missing+=(git)
  node_ok || missing+=(node)
  # pnpm comes pinned (install_pnpm), not from Homebrew.
  have cargo || missing+=(rust)
  if ((${#missing[@]})); then
    say "Installing ${missing[*]} with Homebrew"
    brew install "${missing[@]}"
  fi
  have op || { say "Installing the 1Password CLI"; brew install --cask 1password-cli; }
  hash -r
  git_ok || die "git $GIT_MIN or newer is required (found $(git --version 2>/dev/null || echo none)). Run: brew install git, and put $(brew --prefix)/bin first on PATH"
  node_ok || die "Node $NODE_MAJOR or newer with the Oct 2026 security fixes is required (24.22.1 or later on 24.x, or 26.12.1 or later; found $(node --version)). Run: brew upgrade node"

  if bin/t3blackout signing status | grep -q "not set up"; then
    [[ -d /Applications/1Password.app ]] || die "Install the 1Password app and sign in, then rerun ./install.sh"
    op vault list >/dev/null 2>&1 ||
      die "Turn on 1Password → Settings → Developer → \"Integrate with 1Password CLI\", then rerun ./install.sh"
    if op item get "$OP_ITEM" --vault "$VAULT" >/dev/null 2>&1; then
      say "Importing the shared signing identity from 1Password ($VAULT)"
      bin/t3blackout signing import --vault "$VAULT"
    elif security find-identity -v -p codesigning "$HOME/Library/Keychains/login.keychain-db" |
      grep -qE '"(Apple Development|Developer ID Application): '; then
      say "Sharing your Apple Development certificate through 1Password ($VAULT)"
      bin/t3blackout signing adopt --vault "$VAULT"
    else
      say "No Apple Development certificate found; creating a self-signed one in \"$VAULT\""
      say "Keychain will ask again after each update until you run: bin/t3blackout signing adopt --vault \"$VAULT\" (see README)"
      bin/t3blackout signing init --vault "$VAULT"
    fi
  else
    say "Signing certificate already set up"
  fi
}

# --- Linux ----------------------------------------------------------------------
NODE_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/t3blackout/node"

install_node() {
  local arch
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" tmp sums file want
  tmp="$(mktemp -d)"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")"
  file="$(awk -v suffix="linux-$arch.tar.xz" '$2 ~ suffix"$" { print $2; exit }' <<<"$sums")"
  want="$(awk -v f="$file" '$2 == f { print $1 }' <<<"$sums")"
  [[ -n "$file" && -n "$want" ]] || die "couldn't find a Node $NODE_MAJOR download for linux-$arch"
  say "Installing $file into $NODE_HOME"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  echo "$want  $tmp/$file" | sha256sum -c - >/dev/null || die "Node download failed its checksum"
  rm -rf "$NODE_HOME" && mkdir -p "$NODE_HOME"
  tar -xJf "$tmp/$file" -C "$NODE_HOME" --strip-components=1
  rm -rf "$tmp"
}

linux_setup() {
  [[ -r /etc/os-release ]] || die "can't identify this Linux distribution (/etc/os-release missing)"
  # shellcheck disable=SC1091
  . /etc/os-release
  local family="" sudo=sudo
  case " ${ID:-} ${ID_LIKE:-} " in
    *" arch "*) family=arch ;;
    *" ubuntu "* | *" debian "*) family=debian ;;
    *" fedora "* | *" rhel "* | *" centos "*) family=rhel ;;
  esac
  [[ -n "$family" ]] || die "unsupported distro: ${PRETTY_NAME:-unknown}. Supported: Omarchy/Arch, Ubuntu/Debian, Fedora/RHEL."

  # curl/git only when missing: Fedora/RHEL ship curl-minimal, which conflicts
  # with the full curl package.
  local common=()
  have curl || common+=(curl)
  have git || common+=(git)
  # Upstream's Linux build needs a C toolchain, libsecret headers, pkg-config and
  # ImageMagick (docs/operations/development.md, "Linux AppImage prerequisites").
  say "Installing system packages (${PRETTY_NAME:-$ID})"
  case "$family" in
    arch)
      # No -Sy: Arch doesn't support partial upgrades, and a full -Syu is your call.
      $sudo pacman -S --needed --noconfirm "${common[@]}" base-devel libsecret pkgconf imagemagick python xz tar ||
        die "pacman couldn't install the build packages. Update the system first (omarchy-update, or sudo pacman -Syu), then rerun ./install.sh"
      ;;
    debian)
      $sudo apt-get update -qq
      $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${common[@]}" ca-certificates \
        build-essential libsecret-1-dev pkg-config imagemagick python3 xz-utils
      ;;
    rhel)
      # RHEL clones keep ImageMagick in EPEL and libsecret-devel in CRB.
      if [[ "${ID:-}" != fedora ]]; then
        case "${ID:-}" in
          rhel)
            $sudo dnf install -y -q "https://dl.fedoraproject.org/pub/epel/epel-release-latest-$(rpm -E %rhel).noarch.rpm"
            $sudo subscription-manager repos --enable "codeready-builder-for-rhel-$(rpm -E %rhel)-$(uname -m)-rpms"
            ;;
          *)
            $sudo dnf install -y -q epel-release dnf-plugins-core
            $sudo dnf config-manager --set-enabled crb
            ;;
        esac
      fi
      $sudo dnf install -y -q "${common[@]}" gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick python3 xz tar
      ;;
  esac

  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$NODE_HOME/bin:$PATH"
  node_ok || install_node
  git_ok || die "git $GIT_MIN or newer is required (found $(git --version)). ${PRETTY_NAME:-This distro} ships an older one; install a newer git (e.g. Ubuntu: the git-core PPA), then rerun ./install.sh"

  # Ubuntu 23.10+ blocks unprivileged user namespaces, which Electron's own
  # (Chromium) sandbox needs. Allow them for exactly the installed binary; its
  # path stays fixed across updates.
  local restrict=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
  if [[ -r "$restrict" && "$(cat "$restrict")" == 1 && ! -f /etc/apparmor.d/t3blackout ]]; then
    local exe="${XDG_DATA_HOME:-$HOME/.local/share}/t3blackout/app/t3code"
    say "Adding an AppArmor profile so Electron's sandbox can start ($exe)"
    $sudo tee /etc/apparmor.d/t3blackout >/dev/null <<EOF
abi <abi/4.0>,
include <tunables/global>

profile t3blackout $exe flags=(unconfined) {
  userns,
  include if exists <local/t3blackout>
}
EOF
    $sudo apparmor_parser -r /etc/apparmor.d/t3blackout
  fi
}

# --- build account ----------------------------------------------------------------
BUILDER=_t3blackout
if [[ "$(uname -s)" == Darwin ]]; then
  BUILDER_HOME=/private/var/t3blackout-build
else
  BUILDER_HOME=/var/lib/t3blackout-build
fi

builder_user_mac() {
  dscl . -read "/Users/$BUILDER" >/dev/null 2>&1 && return
  local id=450
  while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$id" ||
    dscl . -list /Groups PrimaryGroupID | awk '{print $2}' | grep -qx "$id"; do
    id=$((id + 1))
  done
  sudo dscl . -create "/Groups/$BUILDER"
  sudo dscl . -create "/Groups/$BUILDER" PrimaryGroupID "$id"
  sudo dscl . -create "/Groups/$BUILDER" RealName "T3 Blackout builder"
  sudo dscl . -create "/Users/$BUILDER"
  sudo dscl . -create "/Users/$BUILDER" UniqueID "$id"
  sudo dscl . -create "/Users/$BUILDER" PrimaryGroupID "$id"
  sudo dscl . -create "/Users/$BUILDER" UserShell /usr/bin/false
  sudo dscl . -create "/Users/$BUILDER" NFSHomeDirectory "$BUILDER_HOME"
  sudo dscl . -create "/Users/$BUILDER" RealName "T3 Blackout builder"
  sudo dscl . -create "/Users/$BUILDER" Password '*'
  sudo dscl . -create "/Users/$BUILDER" IsHidden 1
}

builder_user_linux() {
  id "$BUILDER" >/dev/null 2>&1 && return
  sudo useradd --system --home-dir "$BUILDER_HOME" --create-home \
    --shell "$(command -v nologin || echo /bin/false)" --comment "T3 Blackout builder" "$BUILDER"
}

# Runs a command as the build account, with its own tools first on PATH.
as_builder() {
  sudo -n -u "$BUILDER" -H env HOME="$BUILDER_HOME" \
    PATH="$BUILDER_HOME/node/bin:$BUILDER_HOME/.local/bin:$BUILDER_HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}

# Whether the build account can be set up: it needs sudo once.
can_sudo() {
  have sudo || { say "sudo isn't installed, so builds run as you"; return 1; }
  say "Setting up the build account $BUILDER (sudo asks for your password)"
  sudo -v || { say "No sudo, so builds run as you"; return 1; }
}

# Called as a plain command, never in a condition, so `set -e` stops the
# installer at the first step that fails. The marker that makes builds use the
# account, and the cleanup of your old build data, come only after its toolchain
# checks out.
setup_builder() {
  case "$(uname -s)" in
    Darwin) builder_user_mac ;;
    *) builder_user_linux ;;
  esac
  sudo install -d -o "$BUILDER" -g "$(id -gn "$BUILDER")" -m 755 "$BUILDER_HOME"
  # Lets you (and the scheduled job) act as the build account without a password.
  # Only in that direction: the build account gets no sudo at all.
  local rule
  rule="$(mktemp)"
  printf '%s ALL=(%s) NOPASSWD: ALL\n' "$(id -un)" "$BUILDER" >"$rule"
  sudo visudo -cf "$rule" >/dev/null || die "the sudo rule for $BUILDER didn't validate"
  sudo install -m 440 -o root -g "$(id -gn root)" "$rule" /etc/sudoers.d/t3blackout
  rm -f "$rule"
  sudo -n -u "$BUILDER" true 2>/dev/null ||
    die "sudo can't switch to $BUILDER; make sure /etc/sudoers includes /etc/sudoers.d"

  # Its own toolchain where yours lives in your home (which it can't read). On
  # macOS it shares Homebrew's Node and Rust, which mac_setup checked.
  if [[ "$(uname -s)" == Linux ]]; then
    if ! as_builder node -e "$NODE_CHECK" "$NODE_PATCHED" "$NODE_MAJOR" 2>/dev/null; then
      as_builder bash -c "set -euo pipefail; $(declare -f say die install_node); NODE_MAJOR=$NODE_MAJOR NODE_HOME=$BUILDER_HOME/node install_node"
    fi
    [[ -x "$BUILDER_HOME/.cargo/bin/cargo" ]] || install_rust as_builder
  fi
  if [[ "$(as_builder "$BUILDER_HOME/.local/bin/pnpm" --version 2>/dev/null || true)" != "$PNPM_VERSION" ]]; then
    install_pnpm "$BUILDER_HOME/.local" as_builder
  fi
  as_builder node -e "$NODE_CHECK" "$NODE_PATCHED" "$NODE_MAJOR" ||
    die "$BUILDER's Node ($(as_builder node --version 2>&1)) isn't Node $NODE_MAJOR+ with the Oct 2026 security fixes"
  as_builder cargo --version >/dev/null || die "$BUILDER can't run cargo (on macOS it uses Homebrew's: brew install rust)"

  # Builds run as this account so their scripts can't read your home; make sure
  # they can't (on macOS it shares your staff group, which can read a 0750 home).
  if as_builder test -r "$HOME" || as_builder test -x "$HOME"; then
    say "Making $HOME private (chmod go-rwx): the build account could read it"
    chmod go-rwx "$HOME"
    if as_builder test -r "$HOME" || as_builder test -x "$HOME"; then
      die "$BUILDER can still open $HOME (an ACL entry?); make it private, then rerun"
    fi
  fi

  # Hand over the mirror already fetched here, so the first build doesn't clone again.
  if [[ -d build/upstream/.git && ! -d "$BUILDER_HOME/upstream" ]]; then
    tar -C build -cf - upstream | as_builder tar -C "$BUILDER_HOME" -xf -
  fi
  as_builder touch "$BUILDER_HOME/.t3blackout-builder"
  # Build data from before the build account existed; it keeps its own now.
  rm -rf upstream build
}

# Building as you needs pnpm and Rust here too.
setup_own_toolchain() {
  if [[ "$(PATH="$HOME/.local/bin:$PATH" pnpm --version 2>/dev/null || true)" != "$PNPM_VERSION" ]]; then
    install_pnpm "$HOME/.local"
  fi
  export PATH="$HOME/.local/bin:$PATH"
  if ! have cargo; then
    if [[ "$(uname -s)" == Linux ]]; then install_rust; else brew install rust; fi
  fi
}

# --- main -----------------------------------------------------------------------
main() {
  case "$(uname -s)" in
    Darwin) mac_setup ;;
    Linux) linux_setup ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac

  if can_sudo; then setup_builder; else setup_own_toolchain; fi

  # The role and the locations this environment chose, for every later run
  # (scheduled, from the app, by hand): lib/install-config.mjs.
  bin/t3blackout configure --role "$ROLE"

  say "Building and installing T3 Blackout (a few minutes on first run)"
  bin/t3blackout update

  if [[ "$DAY" == hourly ]]; then say "Scheduling the update check: hourly, and on update requests"; else say "Scheduling the update: ${DAY}, ${HOUR}:00"; fi
  if [[ "$ROLE" == host ]]; then say "It runs as a LaunchDaemon (as you), so it keeps going with nobody logged in"; fi
  bin/t3blackout schedule --hour "$HOUR" --day "$DAY" || say "Couldn't schedule automatic updates here; run bin/t3blackout update by hand."

  say "Done"
  bin/t3blackout status
  if [[ "$(uname -s)" == Linux && ":$PATH:" == *":$NODE_HOME/bin:"* ]]; then
    echo
    echo "To run bin/t3blackout by hand, add this to your shell profile:"
    echo "  export PATH=\"$NODE_HOME/bin:\$HOME/.local/bin:\$HOME/.cargo/bin:\$PATH\""
  fi
  case "$ROLE" in
    ui)
      printf '\nOpen "T3 Blackout" from your app launcher, or run: bin/t3blackout launch\n'
      ;;
    host)
      cat <<'NEXT'

Next, for each account agents run in (docs/two-mac-setup.md, section 3), e.g.:
  sudo scripts/add-agent-account.sh agent-claude --key ~/.ssh/t3blackout.pub
then turn on Remote Login and run that command again. Signed in as the account
(ssh agent-claude@localhost): install the provider CLIs on its own PATH, run
`codex login` and `claude setup-token`, then
/usr/local/libexec/t3blackout/set-claude-token
NEXT
      ;;
    both)
      cat <<'NEXT'

Open "T3 Blackout" from your app launcher, or run: bin/t3blackout launch
For the local standby lane (docs/two-mac-setup.md, section 4.3), e.g.:
  sudo scripts/add-agent-account.sh agent-standby --loopback-only --key ~/.ssh/t3blackout.pub
NEXT
      ;;
  esac
}

# Sourced (tests): functions only.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main; fi

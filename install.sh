#!/usr/bin/env bash
# T3 Blackout installer for macOS and Linux. Safe to rerun: every step checks
# before acting.
#
#   ./install.sh                       # weekly update, Mondays at 04:00 (macOS: vault "Personal")
#   T3BLACKOUT_UPDATE_DAY=daily T3BLACKOUT_UPDATE_HOUR=6 T3BLACKOUT_VAULT=Other ./install.sh
#
# macOS: installs missing tools with Homebrew, sets up the shared signing
#   identity from 1Password (from your Apple Development certificate on the
#   first Mac), builds, installs.
# Linux (Omarchy/Arch, Ubuntu/Debian, Fedora/RHEL): installs system packages
#   with the distro package manager and Node 24 into your home directory, then
#   builds and installs. No signing step: Linux keyrings don't tie access to an
#   app's signature.
# Both: creates a separate, unprivileged build account (_t3blackout) so the
#   scheduled build's dependency and build scripts can't read your home. Needs sudo
#   once; without it, builds run as you.

set -euo pipefail
cd "$(dirname "$0")"

HOUR="${T3BLACKOUT_UPDATE_HOUR:-4}"
DAY="${T3BLACKOUT_UPDATE_DAY:-monday}"
VAULT="${T3BLACKOUT_VAULT:-Personal}"
OP_ITEM="T3 Blackout code signing"
NODE_MAJOR=24

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
node_ok() { have node && (($(node -p 'process.versions.node.split(".")[0]') >= NODE_MAJOR)); }

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
  have git || missing+=(git)
  node_ok || missing+=(node)
  have pnpm || missing+=(pnpm)
  have cargo || missing+=(rust)
  if ((${#missing[@]})); then
    say "Installing ${missing[*]} with Homebrew"
    brew install "${missing[@]}"
  fi
  have op || { say "Installing the 1Password CLI"; brew install --cask 1password-cli; }
  node_ok || die "Node $NODE_MAJOR or newer is required (found $(node --version))."

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
      say "Keychain will ask again after each update until you run: bin/t3blackout signing adopt (see README)"
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
  local family="" sudo=""
  case " ${ID:-} ${ID_LIKE:-} " in
    *" arch "*) family=arch ;;
    *" ubuntu "* | *" debian "*) family=debian ;;
    *" fedora "* | *" rhel "* | *" centos "*) family=rhel ;;
  esac
  [[ -n "$family" ]] || die "unsupported distro: ${PRETTY_NAME:-unknown}. Supported: Omarchy/Arch, Ubuntu/Debian, Fedora/RHEL."
  ((EUID == 0)) || sudo="sudo"

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

setup_builder() {
  if ((EUID == 0)); then
    say "Running as root, so there's no separate build account; builds run as root"
    return 1
  fi
  have sudo || { say "sudo isn't installed, so builds run as you"; return 1; }
  say "Setting up the build account $BUILDER (sudo asks for your password)"
  sudo -v || { say "No sudo, so builds run as you"; return 1; }
  case "$(uname -s)" in
    Darwin) builder_user_mac ;;
    *) builder_user_linux ;;
  esac
  sudo install -d -o "$BUILDER" -g "$(id -gn "$BUILDER")" -m 755 "$BUILDER_HOME"
  # Lets you (and the daily job) act as the build account without a password.
  # Only in that direction: the build account gets no sudo at all.
  local rule
  rule="$(mktemp)"
  printf '%s ALL=(%s) NOPASSWD: ALL\n' "$(id -un)" "$BUILDER" >"$rule"
  sudo visudo -cf "$rule" >/dev/null || die "the sudo rule for $BUILDER didn't validate"
  sudo install -m 440 -o root -g "$(id -gn root)" "$rule" /etc/sudoers.d/t3blackout
  rm -f "$rule"
  sudo -n -u "$BUILDER" true 2>/dev/null ||
    die "sudo can't switch to $BUILDER; make sure /etc/sudoers includes /etc/sudoers.d"

  # Its own toolchain where yours lives in your home (which it can't read).
  if [[ "$(uname -s)" == Linux ]]; then
    as_builder bash -c "$(declare -f say die install_node); NODE_MAJOR=$NODE_MAJOR NODE_HOME=$BUILDER_HOME/node; node_ok() { [[ -x \$NODE_HOME/bin/node ]]; }; node_ok || install_node"
    if [[ ! -x "$BUILDER_HOME/.cargo/bin/cargo" ]]; then
      say "Installing Rust for $BUILDER"
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
        as_builder sh -s -- -y --profile minimal --no-modify-path >/dev/null
    fi
  fi
  if [[ ! -x "$BUILDER_HOME/.local/bin/pnpm" ]]; then
    say "Installing pnpm for $BUILDER"
    as_builder npm install --global --prefix "$BUILDER_HOME/.local" pnpm >/dev/null
  fi
  # Hand over the mirror already fetched here, so the first build doesn't clone again.
  if [[ -d build/upstream/.git && ! -d "$BUILDER_HOME/upstream" ]]; then
    tar -C build -cf - upstream | as_builder tar -C "$BUILDER_HOME" -xf -
  fi
  as_builder touch "$BUILDER_HOME/.t3blackout-builder"
  # Build data from before the build account existed; it keeps its own now.
  rm -rf upstream build
}

# --- main -----------------------------------------------------------------------
case "$(uname -s)" in
  Darwin) mac_setup ;;
  Linux) linux_setup ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac

if ! setup_builder; then
  # Building as you needs pnpm and Rust here too.
  if ! have pnpm; then
    say "Installing pnpm into ~/.local"
    npm install --global --prefix "$HOME/.local" pnpm >/dev/null
  fi
  if ! have cargo; then
    say "Installing Rust (rustup, minimal profile)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path >/dev/null
  fi
fi

say "Building and installing T3 Blackout (a few minutes on first run)"
bin/t3blackout update

say "Scheduling the update: ${DAY}, ${HOUR}:00"
bin/t3blackout schedule --hour "$HOUR" --day "$DAY" || say "Couldn't schedule automatic updates here; run bin/t3blackout update by hand."

say "Done"
bin/t3blackout status
if [[ "$(uname -s)" == Linux && ":$PATH:" == *":$NODE_HOME/bin:"* ]]; then
  echo
  echo "To run bin/t3blackout by hand, add this to your shell profile:"
  echo "  export PATH=\"$NODE_HOME/bin:\$HOME/.local/bin:\$HOME/.cargo/bin:\$PATH\""
fi
cat <<'EOF'

Open "T3 Blackout" from your app launcher, or run: bin/t3blackout launch
EOF

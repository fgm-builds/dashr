#!/usr/bin/env bash
# DASHR one-click installer.
#
# Installs (or reuses) the DeepSeek Harness (dsh), installs the single
# DASHR plugin package (`dsh-rlm-mode`) into a dsh profile, localizes the
# `dashr` agent preset (include path + kernel Python baked in), and makes
# sure the kernel Python environment has `ipykernel`.
#
# Env knobs:
#   DSH_PROFILE     dsh profile to install into            (default: web)
#   DSH_HOME        dsh harness home                       (default: ~/.dsh)
#   DASHR_VERSION   repo ref (tag or branch) to fetch      (default: v0.1.0)
#   DASHR_REPO      repo origin                            (default: github.com/fgm-builds/dashr)
#   DASHR_SRC       existing source dir; skips fetch/build (default: unset)
set -euo pipefail

DSH_PROFILE="${DSH_PROFILE:-web}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DASHR_VERSION="${DASHR_VERSION:-v0.1.0}"
DASHR_REPO="${DASHR_REPO:-https://github.com/fgm-builds/dashr}"
DASHR_SRC="${DASHR_SRC:-}"

info()  { printf '\033[1;32m[dashr]\033[0m %s\n' "$*"; }
step()  { printf '\033[1;34m[dashr]\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m[dashr] error:\033[0m %s\n' "$*" >&2; exit 1; }

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# ---------------------------------------------------------------- 1. env scan
step "1/5 scanning environment"
command -v node    >/dev/null || die "node not found — install Node.js >= 20 first"
command -v npm     >/dev/null || die "npm not found"
command -v python3 >/dev/null || die "python3 not found"
command -v curl    >/dev/null || command -v git >/dev/null || die "need curl or git"

# ------------------------------------------------------ 2. dsh (if missing)
if command -v dsh >/dev/null 2>&1; then
  info "dsh found at $(command -v dsh)"
else
  step "2/5 dsh not found — installing latest via npm"
  if npm install -g @deepseek-ai/dsh@latest >/dev/null 2>&1; then
    info "dsh installed globally"
  else
    PREFIX="$(npm prefix 2>/dev/null || true)"
    [ -n "$PREFIX" ] || die "npm prefix unavailable"
    info "npm -g not writable — installing into $PREFIX"
    npm install --prefix "$PREFIX" @deepseek-ai/dsh@latest >/dev/null
  fi
  command -v dsh >/dev/null || die "dsh installed but not on PATH; add $(npm prefix)/bin to PATH and re-run"
fi

# Resolve the installed dsh's standard agent composition (the preset include
# target). npm layout: <prefix>/bin/dsh -> <prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
DSH_REAL="$(readlink -f "$(command -v dsh)")"
STD_PRESET=""
for cand in \
  "$(dirname "$DSH_REAL")/../config/agent-presets/standard/agent.cordis.yml" \
  "$(dirname "$DSH_REAL")/config/agent-presets/standard/agent.cordis.yml"; do
  if [ -f "$cand" ]; then STD_PRESET="$cand"; break; fi
done
[ -n "$STD_PRESET" ] || die "cannot locate dsh's standard preset (looked next to $DSH_REAL)"
info "standard preset: $STD_PRESET"

# ------------------------------------------- 3. kernel Python (ipykernel)
step "3/5 ensuring the kernel Python has ipykernel"
KERNEL_PY=""
if python3 -c "import ipykernel" >/dev/null 2>&1; then
  KERNEL_PY="$(command -v python3)"
  info "host python3 already has ipykernel ($KERNEL_PY)"
else
  KERNEL_VENV="$DSH_HOME_DIR/dashr-kernel-venv"
  info "host python3 lacks ipykernel — creating $KERNEL_VENV"
  python3 -m venv "$KERNEL_VENV" \
    || die "python3 -m venv failed (install the python3-venv package and re-run)"
  "$KERNEL_VENV/bin/pip" install --quiet --disable-pip-version-check ipykernel \
    || die "pip install ipykernel failed"
  KERNEL_PY="$KERNEL_VENV/bin/python"
  info "kernel python: $KERNEL_PY"
fi

# ------------------------------------------------------ 4. fetch + build
if [ -n "$DASHR_SRC" ]; then
  SRC="$DASHR_SRC"
  info "using local source: $SRC (skipping fetch)"
  if [ ! -d "$SRC/dashr/lib" ]; then
    info "building dsh-rlm-mode (lib/ missing)"
    (cd "$SRC/dashr" && npm install --no-audit --no-fund >/dev/null && npm run build >/dev/null)
  fi
  (cd "$SRC/dashr" && npm pack --pack-destination "$TMP_ROOT" >/dev/null)
else
  step "4/5 fetching dashr $DASHR_VERSION"
  ARCHIVE="$TMP_ROOT/dashr-src.tar.gz"
  if [ "$DASHR_VERSION" = "main" ]; then
    curl -fsSL "$DASHR_REPO/archive/refs/heads/main.tar.gz" -o "$ARCHIVE" \
      || die "download failed: $DASHR_REPO (main)"
  else
    curl -fsSL "$DASHR_REPO/archive/refs/tags/$DASHR_VERSION.tar.gz" -o "$ARCHIVE" \
      || curl -fsSL "$DASHR_REPO/archive/refs/heads/$DASHR_VERSION.tar.gz" -o "$ARCHIVE" \
      || die "download failed: $DASHR_REPO (tag or branch $DASHR_VERSION)"
  fi
  mkdir -p "$TMP_ROOT/src"
  tar -xzf "$ARCHIVE" -C "$TMP_ROOT/src" --strip-components=1
  SRC="$TMP_ROOT/src"
  info "building dsh-rlm-mode"
  (cd "$SRC/dashr" && npm install --no-audit --no-fund >/dev/null && npm run build >/dev/null)
  (cd "$SRC/dashr" && npm pack --pack-destination "$TMP_ROOT" >/dev/null)
fi

# ---------------------------------------------------- 5. plugin + preset
step "5/5 installing plugins into profile '$DSH_PROFILE' and localizing the preset"
# --config.auto-install-peers=false is MANDATORY: the profile already resolves
# @deepseek-ai/* peers through the harness install; letting pnpm auto-install
# them would add a second (divergent) copy of cordis and friends.
dsh plugin --profile "$DSH_PROFILE" add --config.auto-install-peers=false \
  "$TMP_ROOT/dsh-rlm-mode-"*.tgz

PRESET_DIR="$DSH_HOME_DIR/.agent-presets/dashr"
mkdir -p "$PRESET_DIR"
# Bake in the machine-specific include target (the include row is a group
# entry, so it cannot use an env expression) and the resolved kernel Python.
sed -e "s|DASHR_PLACEHOLDER_standard_preset_path_install_script_required|$STD_PRESET|" \
    -e "s|python: !!js process.env.DASHR_KERNEL_PYTHON ?? 'python3'|python: $KERNEL_PY|" \
    "$SRC/dashr/preset/dashr/agent.cordis.yml" > "$PRESET_DIR/agent.cordis.yml"
cp "$SRC/dashr/preset/dashr/preset.yml" "$PRESET_DIR/preset.yml"
info "preset localized at $PRESET_DIR"

# ------------------------------------------------------------- restart note
if pgrep -f "[d]sh .* --port\|[d]sh web" >/dev/null 2>&1 || systemctl --user is-active --quiet dsh.service 2>/dev/null; then
  step "a running dsh instance was detected — restart it to load the new plugins"
  step "  systemd:  systemctl --user restart dsh.service"
  step "  manual:   kill the dsh process, then relaunch with your usual flags"
fi

info "done. Create a new session with agent preset 'dashr' (DASHR) in the dsh web UI."

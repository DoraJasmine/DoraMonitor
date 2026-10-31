#!/usr/bin/env bash
set -euo pipefail

WITH_WEB=0
START=0
PREFIX_DIR="${DORAMONITOR_PREFIX:-$HOME/.local}"
BIN_DIR="${DORAMONITOR_BIN_DIR:-$HOME/.local/bin}"
PACKAGE="${DORAMONITOR_PACKAGE:-doramonitor}"
MODIFY_PATH="${DORAMONITOR_MODIFY_PATH:-1}"
NODE_VERSION="v22.17.0"

usage() {
  cat <<'EOF'
DoraMonitor Linux installer

Usage: bash scripts/install-linux.sh [options]

  --with-web       Register systemd user services for Web and daemon
  --start          Start after installation
  --prefix <dir>   npm global prefix (default: ~/.local)
  --bin-dir <dir>  Command directory (default: ~/.local/bin)
  -h, --help       Show this help

Installs from the public npm registry without sudo. Node.js 18+ is used when
available; otherwise a portable Node.js 22 is installed for the current user.
EOF
}

info() { printf '==> %s\n' "$1"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-web) WITH_WEB=1; shift ;;
    --start) START=1; shift ;;
    --prefix)
      [ "$#" -ge 2 ] || { printf '--prefix requires a directory\n' >&2; exit 2; }
      PREFIX_DIR="$2"; shift 2 ;;
    --bin-dir)
      [ "$#" -ge 2 ] || { printf '--bin-dir requires a directory\n' >&2; exit 2; }
      BIN_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Linux" ]; then
  printf 'This installer supports Linux only.\n' >&2
  exit 1
fi
if [[ "$PREFIX_DIR" != /* || "$BIN_DIR" != /* ]]; then
  printf -- '--prefix and --bin-dir must be absolute paths.\n' >&2
  exit 2
fi

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  if [ "$(node -p "Number(process.versions.node.split('.')[0])")" -ge 18 ]; then
    NODE_BIN="$(command -v node)"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    *) printf 'Unsupported CPU architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
  esac
  NODE_HOME="${DORAMONITOR_NODE_HOME:-$HOME/.local/share/doramonitor-node}"
  NODE_BIN="$NODE_HOME/bin/node"
  if [ ! -x "$NODE_BIN" ]; then
    command -v tar >/dev/null 2>&1 || { printf 'tar is required to install Node.js.\n' >&2; exit 1; }
    ARCHIVE="node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
    URL="https://nodejs.org/dist/$NODE_VERSION/$ARCHIVE"
    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT
    info "Downloading Node.js $NODE_VERSION"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$URL" -o "$TMP_DIR/$ARCHIVE"
    elif command -v wget >/dev/null 2>&1; then
      wget -q "$URL" -O "$TMP_DIR/$ARCHIVE"
    else
      printf 'curl or wget is required to download Node.js.\n' >&2
      exit 1
    fi
    mkdir -p "$NODE_HOME"
    tar -xJf "$TMP_DIR/$ARCHIVE" -C "$TMP_DIR"
    cp -a "$TMP_DIR/node-$NODE_VERSION-linux-$NODE_ARCH/." "$NODE_HOME/"
  fi
fi

NODE_DIR="$(dirname "$NODE_BIN")"
NPM_BIN="$NODE_DIR/npm"
[ -x "$NPM_BIN" ] || { printf 'npm was not found next to %s.\n' "$NODE_BIN" >&2; exit 1; }
export PATH="$NODE_DIR:$BIN_DIR:$PATH"
mkdir -p "$PREFIX_DIR" "$BIN_DIR"

info "Installing DoraMonitor from npm"
"$NPM_BIN" install -g --prefix "$PREFIX_DIR" "$PACKAGE"
PACKAGE_DIR="$PREFIX_DIR/lib/node_modules/doramonitor"
[ -f "$PACKAGE_DIR/src/doramonitor.js" ] || { printf 'DoraMonitor package was not found in %s.\n' "$PACKAGE_DIR" >&2; exit 1; }

cat > "$BIN_DIR/doramonitor" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$PACKAGE_DIR/src/doramonitor.js" "\$@"
EOF
chmod +x "$BIN_DIR/doramonitor"
"$BIN_DIR/doramonitor" --version

if [ "$MODIFY_PATH" = "1" ]; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) export PATH="$BIN_DIR:$PATH" ;;
  esac
  PROFILE="$HOME/.profile"
  MARKER="# DoraMonitor command path"
  if ! grep -F "$MARKER" "$PROFILE" >/dev/null 2>&1; then
    printf '\n%s\nexport PATH="%s:$PATH"\n' "$MARKER" "$BIN_DIR" >> "$PROFILE"
  fi
fi

if [ "$WITH_WEB" -eq 1 ]; then
  command -v systemctl >/dev/null 2>&1 || { printf 'systemctl is required for --with-web.\n' >&2; exit 1; }
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/doramonitor-web.service" <<EOF
[Unit]
Description=DoraMonitor dashboard
After=default.target

[Service]
Type=simple
ExecStart="$NODE_BIN" "$PACKAGE_DIR/src/server.js" --host 127.0.0.1 --port 3847 --no-open
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  cat > "$UNIT_DIR/doramonitor-daemon.service" <<EOF
[Unit]
Description=DoraMonitor quota sampler and synchronization daemon
After=network-online.target

[Service]
Type=simple
ExecStart="$NODE_BIN" "$PACKAGE_DIR/src/doramonitor.js" daemon
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
  info "Registering systemd user services"
  systemctl --user daemon-reload
  systemctl --user enable doramonitor-web.service doramonitor-daemon.service
fi

if [ "$START" -eq 1 ]; then
  info "Starting DoraMonitor"
  if [ "$WITH_WEB" -eq 1 ]; then
    systemctl --user start doramonitor-web.service doramonitor-daemon.service
  else
    "$BIN_DIR/doramonitor" web --background --no-open
  fi
fi

printf '\nDoraMonitor installed successfully.\n'
printf 'Command: %s/doramonitor\n' "$BIN_DIR"
printf 'Dashboard: http://127.0.0.1:3847\n'
if [ "$MODIFY_PATH" = "1" ]; then
  printf 'Open a new terminal, or run: export PATH="%s:$PATH"\n' "$BIN_DIR"
fi

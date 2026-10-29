#!/usr/bin/env bash
# Ski Legacy multiplayer server: one-shot setup for a fresh Ubuntu / Debian VPS (run as root). Safe to run again:
# every step checks first, so the same command also UPDATES the server to the latest code on GitHub.
#
#   From your Mac (in the game's folder):
#     ssh -i ~/Downloads/hetzner_rsa root@138.199.163.183 'bash -s' < server/setup.sh
#
# What it does: installs Node 20 (NodeSource), git, ufw and Caddy (official apt repo); creates the `skilegacy`
# user; fetches the server/ folder of https://github.com/FoxFlame27/Ski-Legacy (branch legacy-express) into
# /opt/skilegacy/server (or copies it from $SRC_DIR if you set that, e.g. after uploading a tarball); runs npm ci;
# installs the systemd service `skilegacy` (restart always); writes the Caddyfile that serves
#   wss://138-199-163-183.sslip.io/ws  ->  the Node server on 127.0.0.1:8787   (Let's Encrypt certificate, automatic)
# and opens the firewall for SSH (22 + your sshd port), 80 and 443. Player data lives in /var/lib/skilegacy and is
# never touched by an update.
set -euo pipefail

REPO="${REPO:-https://github.com/FoxFlame27/Ski-Legacy.git}"
BRANCH="${BRANCH:-legacy-express}"
DOMAIN="${DOMAIN:-138-199-163-183.sslip.io}"
PORT="${PORT:-8787}"
APP_DIR=/opt/skilegacy
DATA_DIR=/var/lib/skilegacy
SVC_USER=skilegacy
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root (ssh root@...)." >&2; exit 1; }

say "Base packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https rsync

say "Node.js 20"
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [ "$NODE_MAJOR" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

say "Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
caddy version

say "User and folders"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
chown "$SVC_USER:$SVC_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"

say "Server code"
if [ -n "${SRC_DIR:-}" ]; then
  [ -f "$SRC_DIR/lib/server.js" ] || { echo "SRC_DIR=$SRC_DIR has no lib/server.js" >&2; exit 1; }
  SRC="$SRC_DIR"
else
  if [ -d "$APP_DIR/repo/.git" ]; then
    git -C "$APP_DIR/repo" fetch --depth 1 origin "$BRANCH"
    git -C "$APP_DIR/repo" reset --hard FETCH_HEAD
  else
    rm -rf "$APP_DIR/repo"
    if ! git clone --depth 1 --branch "$BRANCH" --filter=blob:none --sparse "$REPO" "$APP_DIR/repo"; then
      echo "Could not clone $REPO (is it private?). Upload the folder instead, see server/README.md (tar over ssh)." >&2
      exit 1
    fi
  fi
  git -C "$APP_DIR/repo" sparse-checkout set server
  SRC="$APP_DIR/repo/server"
fi
mkdir -p "$APP_DIR/server"
rsync -a --delete --exclude node_modules --exclude data "$SRC/" "$APP_DIR/server/"
cd "$APP_DIR/server"
npm ci --omit=dev --no-audit --no-fund
chown -R root:root "$APP_DIR/server"
chmod -R a+rX "$APP_DIR/server"

say "systemd service"
cat > /etc/systemd/system/skilegacy.service <<EOF
[Unit]
Description=Ski Legacy multiplayer server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR/server
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=DATA_DIR=$DATA_DIR
ExecStart=/usr/bin/env node index.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable skilegacy >/dev/null
systemctl restart skilegacy

say "Caddy: https://$DOMAIN  (wss://$DOMAIN/ws)"
cat > /etc/caddy/Caddyfile <<EOF
# Ski Legacy: TLS (Let's Encrypt, automatic) in front of the Node server. WebSockets pass straight through.
$DOMAIN {
	handle /ws* {
		reverse_proxy 127.0.0.1:$PORT
	}
	handle /health {
		reverse_proxy 127.0.0.1:$PORT
	}
	handle {
		respond "Ski Legacy multiplayer server" 200
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Firewall (ufw): SSH, 80, 443"
SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
ufw allow 22/tcp >/dev/null
[ -n "$SSH_PORT" ] && [ "$SSH_PORT" != "22" ] && ufw allow "$SSH_PORT/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/   /'

say "Check"
sleep 2
systemctl --no-pager --lines=5 status skilegacy || true
curl -fsS "http://127.0.0.1:$PORT/health" && echo
echo
echo "Done. The game connects to wss://$DOMAIN/ws"
echo "(The first HTTPS request can take ~30 s while Caddy gets the certificate.)"
echo "Logs:    journalctl -u skilegacy -f        Caddy: journalctl -u caddy -f"

#!/usr/bin/env bash
# Ski Legacy multiplayer server: one-shot setup for an Ubuntu / Debian VPS (run as root). Safe to run again:
# every step checks first, so the same command also UPDATES the server to the latest code on GitHub.
#
#   From your Mac (in the game's folder; the login user is nnechm, the script runs with sudo, -t lets sudo ask for the
#   password):
#     scp -i ~/Downloads/hetzner_rsa server/setup.sh nnechm@138.199.163.183:/tmp/skilegacy-setup.sh && ssh -t -i ~/Downloads/hetzner_rsa nnechm@138.199.163.183 'sudo bash /tmp/skilegacy-setup.sh'
#
# What it does: installs Node 20 (NodeSource) and git; creates the `skilegacy` user; fetches the server/ folder of
# https://github.com/FoxFlame27/Ski-Legacy (branch legacy-express) into /opt/skilegacy/server (or copies it from
# $SRC_DIR if you set that, e.g. after uploading a tarball); runs npm ci; installs the systemd service `skilegacy`
# (restart always) and serves
#   wss://138-199-163-183.sslip.io/ws  ->  the Node server on 127.0.0.1:18787 (or the next free port)
# through a TLS front:
#   - an nginx that already runs here (another website on this server) gets ONE extra site of its own for the game's
#     hostname, with a Let's Encrypt certificate from certbot; your other sites are not touched (nginx -t is checked
#     before every reload, and the game's site is taken out again if the check fails);
#   - otherwise Caddy (automatic Let's Encrypt).
# The firewall is never switched on; if ufw is already on, 80 and 443 are allowed. Player data lives in
# /var/lib/skilegacy and is never touched by an update.
set -euo pipefail

REPO="${REPO:-https://github.com/FoxFlame27/Ski-Legacy.git}"
BRANCH="${BRANCH:-legacy-express}"
DOMAIN="${DOMAIN:-138-199-163-183.sslip.io}"
PORT="${PORT:-18787}" # (the first free one from here is used: 8787 is taken by another app on this server)
APP_DIR=/opt/skilegacy
DATA_DIR=/var/lib/skilegacy
SVC_USER=skilegacy
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run it with sudo: sudo bash /tmp/skilegacy-setup.sh" >&2; exit 1; }

say "Base packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https rsync

say "Node.js 20"
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [ "$NODE_MAJOR" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

# the TLS front: nginx when one already runs here (another website), else Caddy
USE_NGINX=0
if command -v nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx; then USE_NGINX=1; fi
if [ "$USE_NGINX" = 1 ]; then
  say "nginx is already running: the game gets a site of its own (your other sites are not touched)"
  # (an earlier run of this script may have installed Caddy: it must never take ports 80 / 443 from nginx)
  if command -v caddy >/dev/null 2>&1; then systemctl disable --now caddy >/dev/null 2>&1 || true; fi
  command -v certbot >/dev/null 2>&1 || apt-get install -y certbot
  dpkg -s python3-certbot-nginx >/dev/null 2>&1 || apt-get install -y python3-certbot-nginx
else
  say "Caddy"
  if ! command -v caddy >/dev/null 2>&1; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  fi
  caddy version
fi

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

say "Port"
# our own service off first (so its old port counts as free), then the first port nothing else listens on
systemctl stop skilegacy >/dev/null 2>&1 || true
port_busy() { ss -Hltn "( sport = :$1 )" 2>/dev/null | grep -q .; }
for _ in $(seq 1 50); do port_busy "$PORT" || break; PORT=$((PORT + 1)); done
port_busy "$PORT" && { echo "No free port found near $PORT" >&2; exit 1; }
echo "   the game server listens on 127.0.0.1:$PORT"

say "systemd service"
cat > /etc/systemd/system/skilegacy.service <<UNIT
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
UNIT
systemctl daemon-reload
systemctl enable skilegacy >/dev/null
systemctl restart skilegacy

if [ "$USE_NGINX" = 1 ]; then
  say "nginx: https://$DOMAIN  (wss://$DOMAIN/ws)"
  NGX_SITE=/etc/nginx/sites-available/skilegacy
  NGX_LINK=/etc/nginx/sites-enabled/skilegacy
  mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  # reload only after nginx -t passes; on a failed check the game's site is taken out again (your sites keep running)
  ngx_ok() {
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx
    else echo "nginx config check failed: the game's site is taken out again" >&2; nginx -t || true; rm -f "$NGX_LINK"; exit 1; fi
  }
  if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    # first plain HTTP for the game's hostname, so certbot can prove it owns it
    cat > "$NGX_SITE" <<SITE
server {
	listen 80;
	listen [::]:80;
	server_name $DOMAIN;
	location / { return 200 "Ski Legacy multiplayer server\n"; }
}
SITE
    ln -sf "$NGX_SITE" "$NGX_LINK"
    ngx_ok
    certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring
  fi
  cat > "$NGX_SITE" <<SITE
# Ski Legacy multiplayer: TLS in front of the Node server; WebSockets on /ws.
server {
	listen 80;
	listen [::]:80;
	server_name $DOMAIN;
	location / { return 301 https://\$host\$request_uri; }
}
server {
	listen 443 ssl;
	listen [::]:443 ssl;
	server_name $DOMAIN;
	ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
	location /ws {
		proxy_pass http://127.0.0.1:$PORT;
		proxy_http_version 1.1;
		proxy_set_header Upgrade \$http_upgrade;
		proxy_set_header Connection "upgrade";
		proxy_set_header Host \$host;
		proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
		proxy_read_timeout 3600s;
		proxy_send_timeout 3600s;
	}
	location /health { proxy_pass http://127.0.0.1:$PORT; }
	location / { return 200 "Ski Legacy multiplayer server\n"; }
}
SITE
  ln -sf "$NGX_SITE" "$NGX_LINK"
  ngx_ok
else
  say "Caddy: https://$DOMAIN  (wss://$DOMAIN/ws)"
  cat > /etc/caddy/Caddyfile <<CADDY
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
CADDY
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl enable caddy >/dev/null
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi

say "Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  echo "   ufw is on: 80 and 443 allowed"
else
  echo "   ufw is off: nothing changed (a Hetzner Cloud Firewall, if you use one, must allow 80 and 443)"
fi

say "Check"
sleep 2
systemctl --no-pager --lines=5 status skilegacy || true
sleep 2
# (the game server's own health answer carries "proto": anything else is another app on that port)
if curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"proto"'; then echo "Game server: OK"
else echo "Game server is NOT running. Its log:"; journalctl -u skilegacy -n 30 --no-pager || true; fi
sleep 1
if curl -fsS "https://$DOMAIN/health" 2>/dev/null | grep -q '"proto"'; then echo "HTTPS check: OK"; else echo "HTTPS check failed (with Caddy the first one can take ~30 s while it gets the certificate)"; fi
echo
echo "Done. The game connects to wss://$DOMAIN/ws"
echo "Logs:    journalctl -u skilegacy -f        web front: journalctl -u nginx -f (or -u caddy)"

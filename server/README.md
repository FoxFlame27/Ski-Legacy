# Ski Legacy multiplayer server

A small Node 20 WebSocket server (one dependency: `ws`). It keeps the accounts (unique names), the multiplayer
saves, the worlds (max 15 players each) and everything shared. The protocol is in `docs/multiplayer.md`.

The game connects to **`wss://138-199-163-183.sslip.io/ws`**. `138-199-163-183.sslip.io` is a free hostname that
points at the VPS (138.199.163.183). Caddy uses it to get a Let's Encrypt certificate, which the game needs
because it runs on a secure origin.

## Install on the Hetzner VPS (one command from your Mac)

Open Terminal in the game's folder (the one with `server/` in it) and run the line below. Replace
`~/Downloads/hetzner_rsa` with the path to your SSH key if it is somewhere else.

```sh
ssh -i ~/Downloads/hetzner_rsa root@138.199.163.183 'bash -s' < server/setup.sh
```

It takes a few minutes the first time. It installs Node 20, Caddy, git and ufw. It downloads the `server/` folder
from GitHub (`FoxFlame27/Ski-Legacy`, branch `legacy-express`), installs the systemd service `skilegacy` (it
restarts by itself), writes the Caddy config and opens ports 22, 80 and 443. At the end it prints `{"ok":true,...}`.

Check it from your Mac:

```sh
curl https://138-199-163-183.sslip.io/health
```

The first request can take about 30 seconds while Caddy gets the certificate.

If you use the Hetzner Cloud Firewall (in the Hetzner console), it must allow TCP 80 and 443 as well.

### If the GitHub repo is private

The script cannot clone a private repo. Upload the folder over SSH instead (also from the game's folder):

```sh
tar -czf - --exclude node_modules --exclude data server | ssh -i ~/Downloads/hetzner_rsa root@138.199.163.183 'rm -rf /tmp/sl && mkdir -p /tmp/sl && tar -xzf - -C /tmp/sl && SRC_DIR=/tmp/sl/server bash /tmp/sl/server/setup.sh'
```

## Update the server after a push

Run the same install command again. It pulls the latest `server/` from GitHub, runs `npm ci` and restarts the
service. Player data in `/var/lib/skilegacy` is never touched.

```sh
ssh -i ~/Downloads/hetzner_rsa root@138.199.163.183 'bash -s' < server/setup.sh
```

## Logs and status

```sh
ssh -i ~/Downloads/hetzner_rsa root@138.199.163.183 'journalctl -u skilegacy -f'          # live server log (Ctrl+C to stop)
ssh -i ~/Downloads/hetzner_rsa root@138.199.163.183 'journalctl -u skilegacy -n 200 --no-pager'
ssh -i ~/Downloads/hetzner_rsa root@138.199.163.183 'systemctl status skilegacy caddy --no-pager'
ssh -i ~/Downloads/hetzner_rsa root@138.199.163.183 'systemctl restart skilegacy'
ssh -i ~/Downloads/hetzner_rsa root@138.199.163.183 'journalctl -u caddy -n 100 --no-pager'   # certificate problems
```

## Data and backups

- Player data lives in `/var/lib/skilegacy/accounts.json` and `/var/lib/skilegacy/profiles.json`.
- Each file is written atomically (a temp file, then a rename).
- Accounts store only a hash of each player's secret token.

To back them up:

```sh
scp -i ~/Downloads/hetzner_rsa root@138.199.163.183:/var/lib/skilegacy/*.json ./backup/
```

## Run it locally

```sh
cd server
npm install
npm start              # ws://127.0.0.1:8787  (PORT, HOST, DATA_DIR env vars; data in server/data, gitignored)
npm test               # starts a server on a random port and checks it with fake clients
```

To play against the local server, open the game with `?mp=ws://localhost:8787/ws`, for example
`http://localhost:5173/?mp=ws://localhost:8787/ws` under `npm run dev`.

## Prices

The server checks every purchase against `lib/catalog.json`, which is generated from the game's own price tables.
After you change a price in the game, regenerate it from the repo root:

```sh
node server/tools/gen-catalog.mjs
```

`npm test` fails when the catalog no longer matches the game.

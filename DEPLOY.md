# Deploying to a Hetzner VPS with PM2 + Nginx

This guide hosts the TETR.IO Stacking Trainer on a Hetzner Cloud VPS. The app is a
**static single-page app** — `npm run build` emits plain files to `dist/` with no
server runtime. So PM2's job here is to keep a small Node **static file server**
(`serve`) alive on a local port; your **existing Nginx** reverse-proxies to it over
HTTPS. The server already runs other PM2 apps, and this one is **added alongside**
them without disturbing them.

```
Browser ──HTTPS(443)──▶ Nginx ──proxy_pass──▶ 127.0.0.1:<PORT> (PM2 → serve -s dist)
```

> **Why PM2 for a static app?** Strictly, Nginx could serve `dist/` directly with
> zero Node processes. This guide uses PM2 so the app is managed the same way as the
> other services on the box (one `pm2 status`, uniform restart/boot-persist). If
> you'd rather drop the Node process entirely, see
> [Appendix B](#appendix-b--nginx-only-no-pm2).

> **The trainer is fully client-side** — dragging in a `.ttr`/`.ttrm`, the target
> ghost, garbage, and the "stack like the pro" scoring all run in the browser with
> no backend. The **only** feature that needs the API is publishing/browsing shared
> segments, which requires **Discord login**. If you don't need that, deploy just
> the static app (steps 1–9) and skip [step 10](#10-optional-api-service--discord-login).
> Without the API the login button simply does nothing and the app stays anonymous.

---

## This deployment's specifics

The commands below use the actual values for this server. Adapt them if yours
differ:

| Thing | Value |
| --- | --- |
| SSH user / host | `betanine@ubuntu-4gb-hel1-1` (IP `204.168.150.104`) |
| Project path | `/home/betanine/ThomasTheDankEngineCode/Stacker` |
| Domain | `stacker.tetrisatuci.org` (DNS managed at **Squarespace**) |
| App port | **pick a free one** — 3000 was taken here; this guide uses `3001` |
| Node | installed via **nvm** (v25.x), *not* system/apt Node |
| Existing PM2 apps | `tetrisatuci-website`, `yauna-badge` (leave untouched) |

Two of these caused real problems and are handled explicitly below:

- **nvm Node** means `serve` must be launched by its **absolute path** in
  **fork mode** — otherwise PM2 resolves `serve` to its own built-in `pm2 serve`
  module and crash-loops in cluster mode (see [step 4](#4-add-it-under-pm2)).
- **Port 3000 was in use**, so the app port is a variable you set in exactly two
  places (PM2 args + Nginx `proxy_pass`); they must match.

---

## Prerequisites

- A Hetzner Cloud server running Ubuntu 22.04/24.04.
- SSH access as a sudo-capable user (`betanine` here).
- Nginx already installed and running, already fronting other sites.
- The project already cloned to `~/ThomasTheDankEngineCode/Stacker`.
- The domain's **A record** pointing at the server IP (see
  [step 6](#6-dns-at-squarespace)). TLS in [step 7](#7-point-nginx-at-it) needs DNS
  to resolve first.

---

## 1. Install `serve` and pick a port

Node, npm, and PM2 are already present via nvm. You only need the `serve` static
server, installed into the **same nvm Node** you'll run PM2 under:

```bash
npm install -g serve      # NOT sudo — nvm installs into your user prefix
which serve               # note this absolute path; step 4 needs it
                          # e.g. /home/betanine/.nvm/versions/node/v25.9.0/bin/serve
```

Then choose a **free port** for the app (3000 is taken on this box). Empty output
for a port means it's free:

```bash
for p in 3001 3002 4000 8080; do
  printf "port %s: " "$p"
  sudo ss -tlnp | grep -q ":$p " && echo "IN USE" || echo "free"
done
```

The rest of this guide uses **3001**. Substitute your choice everywhere it appears.

---

## 2. Build the app

The project is already at `~/ThomasTheDankEngineCode/Stacker`. Install deps and
build:

```bash
cd ~/ThomasTheDankEngineCode/Stacker
npm ci            # clean, lockfile-exact install
npm run build     # tsc + vite build → dist/
```

`npm run build` runs `tsc` first, so a type error fails the build before producing a
broken bundle. When it finishes you'll have `dist/` containing `index.html` + hashed
assets.

> **Low-RAM servers:** the TypeScript + Vite build can spike memory. On this 4 GB
> box it's fine, but on a 2 GB box add swap once so the build isn't OOM-killed:
> ```bash
> sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
> sudo mkswap /swapfile && sudo swapon /swapfile
> echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
> ```

> **Rebuilding on your laptop instead?** Build locally and `rsync` just `dist/` up:
> `rsync -avz --delete dist/ betanine@204.168.150.104:~/ThomasTheDankEngineCode/Stacker/dist/`

> **Using the API (step 10)?** The API base URL is baked in at **build time** from
> `VITE_API_URL` (defaults to `http://localhost:8000` if unset). For a prod build
> that talks to the deployed API, set it on the build command:
> ```bash
> VITE_API_URL=https://api.stacker.tetrisatuci.org npm run build
> ```
> Changing it later means **rebuilding** — it is not a runtime setting.

---

## 3. Coexisting with the existing PM2 apps

This box already runs `tetrisatuci-website` and `yauna-badge` under PM2. Adding
`stacker` is purely **additive** — PM2 runs a list of independent processes:

- `pm2 start` on an ecosystem file that defines only `stacker` **appends** it; it
  never touches the other two.
- The only things that must not collide: the process **name** (`stacker`), the
  **port** (chosen in step 1), and each app's Nginx `server_name`.
- `pm2 save` (step 5) snapshots **all** processes, so the existing two stay in the
  saved boot list too.
- **Never** run `pm2 delete all`, `pm2 kill`, or `pm2 resurrect` from a stale dump —
  those are the only commands that would hit the other apps.

---

## 4. Add it under PM2

Create a PM2 **ecosystem file** so the config is version-controlled. In the project
root add `ecosystem.config.cjs`:

```js
// ecosystem.config.cjs — PM2 process definition for the static server.
module.exports = {
  apps: [
    {
      name: "stacker",
      // IMPORTANT: absolute path from `which serve`. If you pass just "serve",
      // PM2 resolves it to its OWN built-in `pm2 serve` module and crash-loops.
      script: "/home/betanine/.nvm/versions/node/v25.9.0/bin/serve",
      // -s : SPA mode (unknown paths fall back to index.html)
      // -l : listen port (must match Nginx proxy_pass)
      // -n : no clipboard/copy prompt (headless)
      args: "-s dist -l 3001 -n",
      cwd: "/home/betanine/ThomasTheDankEngineCode/Stacker",
      // IMPORTANT: fork, NOT cluster. `serve` isn't cluster-aware; cluster mode
      // makes it exit immediately and PM2 restart-loops until it errors out.
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "200M",
      env: { NODE_ENV: "production" },
    },
  ],
};
```

> Replace the `script` path with whatever `which serve` printed, and `3001` with
> your chosen port.

Start it and confirm it's genuinely stable — watch that **uptime climbs** and the
restart counter (`↺`) stays at 0:

```bash
cd ~/ThomasTheDankEngineCode/Stacker
pm2 start ecosystem.config.cjs
pm2 status                       # 3 apps now; "stacker" online, uptime rising
curl -I http://127.0.0.1:3001    # expect HTTP/1.1 200 OK
```

If `stacker` flaps between `online` and `errored` (rapidly climbing `↺`), it's the
cluster/`serve`-path problem above — `pm2 logs stacker` will show
`starting in -cluster mode-` or a path ending in `pm2/lib/API/Serve.js`. Fix the
`script` path + `exec_mode`, then `pm2 delete stacker && pm2 start ecosystem.config.cjs`.

---

## 5. Make PM2 survive reboots

The startup hook is **already installed** for `betanine` (that's why the existing
apps survive reboots), so you do **not** re-run `pm2 startup`. Just re-snapshot the
process list so `stacker` is included:

```bash
pm2 save          # saves ALL three apps to the boot list
```

Only if `pm2 status` comes back empty after a reboot is the hook missing — then run
`pm2 startup systemd` once and execute the exact `sudo env … pm2 startup` line it
prints, followed by `pm2 save`.

---

## 6. DNS at Squarespace

The app is served at `stacker.tetrisatuci.org`. That name needs a DNS **A record**
pointing at the server before HTTPS (or even the browser) can reach it — a missing
record shows up as `DNS_PROBE_POSSIBLE` / "DNS address could not be found".

First confirm where the domain's DNS actually lives (from your **laptop**):

```bash
dig +short NS tetrisatuci.org
# ns1.squarespacedns.com / ns2... → manage at Squarespace (below)
# cloudflare.com / awsdns / …     → add the record THERE instead
```

If it's Squarespace-managed: **Settings → Domains → `tetrisatuci.org` → DNS**, then
**Add Record**:

| Field | Value |
| --- | --- |
| Type | **A** |
| Host | **`stacker`**  ← just the label, not the full name |
| Data / Value | **`204.168.150.104`** |
| TTL | default (or 5 min) |

Leave the existing records for the other two sites alone. Squarespace DNS only
resolves the name to your IP — there's no proxy to interfere with Certbot. Verify
before continuing (wait a few minutes for propagation):

```bash
dig +short stacker.tetrisatuci.org      # must print 204.168.150.104
```

Don't run Certbot until this returns the IP.

---

## 7. Point Nginx at it

Your Nginx is already running (fronting the other sites), so add a **new** server
block — don't edit the existing ones. Create `/etc/nginx/sites-available/stacker`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name stacker.tetrisatuci.org;   # must EXACTLY match the DNS record + URL

    # Reverse-proxy to the PM2-managed static server (port from step 1).
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Long-cache the hashed build assets (filenames change on every build).
    location /assets/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
```

> Both `proxy_pass` ports must equal the `serve` port from step 1. The port lives in
> exactly **two files** — this one and `ecosystem.config.cjs` — and they must match,
> or you get a **502 Bad Gateway**.

Enable it, test, and reload (reload, don't restart — the other sites stay up):

```bash
sudo ln -s /etc/nginx/sites-available/stacker /etc/nginx/sites-enabled/
sudo nginx -t          # validates ALL blocks; must say "test is successful"
sudo systemctl reload nginx
```

Confirm the server responds *before* worrying about DNS — this faked `Host` header
bypasses DNS and proves Nginx→serve works:

```bash
curl -I -H "Host: stacker.tetrisatuci.org" http://127.0.0.1
# 200 OK  → server good; if DNS has propagated, the browser works too
# 502     → port mismatch or serve is down (check pm2 status / pm2 logs stacker)
```

Once DNS resolves and HTTP works, add TLS.

### TLS with Let's Encrypt

Certbot's Nginx plugin edits the server block to add `listen 443 ssl` and an
HTTP→HTTPS redirect automatically:

```bash
sudo certbot --nginx -d stacker.tetrisatuci.org     # choose "redirect"
```

(If `certbot` isn't installed yet: `sudo apt-get install -y certbot python3-certbot-nginx`.)
Confirm auto-renewal works:

```bash
sudo certbot renew --dry-run
```

The site is now live on `https://stacker.tetrisatuci.org`.

---

## 8. Firewall

Only 22/80/443 should face the internet — **not** the app port (it stays
loopback-local behind Nginx). With UFW:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # opens 80 + 443
sudo ufw enable
sudo ufw status
```

Do the same in the **Hetzner Cloud Console → Firewalls** if you use their
network-level firewall: allow inbound 22/80/443, deny the rest. Since `serve`
listens on the app port but neither firewall opens it, it's unreachable externally.

---

## 9. Redeploying after code changes

Pull, rebuild, and reload the process. `serve` picks up the new `dist/` on restart:

```bash
cd ~/ThomasTheDankEngineCode/Stacker
git pull
npm ci
npm run build
pm2 reload stacker     # zero-downtime reload; leaves the other apps alone
```

Because asset filenames are content-hashed, returning visitors fetch the new bundle
immediately while `index.html` (served uncached) points at the new hashes.

Optionally drop this in a `deploy.sh` in the repo:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd ~/ThomasTheDankEngineCode/Stacker
git pull --ff-only
npm ci
npm run build
pm2 reload stacker
echo "Deployed $(git rev-parse --short HEAD)"
```

`chmod +x deploy.sh`, then redeploy with `./deploy.sh`.

---

## 10. (Optional) API service + Discord login

Everything above serves the **static trainer**, which is fully functional on its
own. This step adds the **API** (`server/` — FastAPI + Postgres + MinIO, run via
Docker Compose) so users can log in with Discord and publish/browse shared
segments. Skip it if you don't need those features.

The API runs as a **separate origin** on its own subdomain, `api.stacker.tetrisatuci.org`,
reverse-proxied by the same Nginx to the Compose stack on `127.0.0.1:8000`:

```
Browser ─HTTPS─▶ Nginx ─▶ 127.0.0.1:3001  (static app)  stacker.tetrisatuci.org
                      └─▶ 127.0.0.1:8000  (FastAPI/API)  api.stacker.tetrisatuci.org
```

> **Why a subdomain, and the one gotcha it creates.** The frontend and API are then
> *different sites* to the browser, so the HttpOnly session cookie is only sent on
> the app's cross-origin `fetch`es when it's **`SameSite=None; Secure`** (which in
> turn requires HTTPS on the API). The server reads these from env
> (`COOKIE_SAMESITE`/`COOKIE_SECURE`) — set them in 10c. Get this wrong and login
> "succeeds" but the app immediately shows you logged out.

### 10a. Create the Discord application

At **[discord.com/developers/applications](https://discord.com/developers/applications)**
→ **New Application** → **OAuth2**:

- Copy the **Client ID** and **Client Secret**.
- Under **Redirects**, add **both** callback URLs (Discord allows several):
  - `http://localhost:8000/auth/callback/discord`  (local dev)
  - `https://api.stacker.tetrisatuci.org/auth/callback/discord`  (prod)

> The redirect URI is the **API's** callback, not the app URL — Discord sends the
> auth code there; the API sets the session cookie and bounces the browser back to
> the frontend.

### 10b. DNS for the API subdomain

Add a second **A record** (same box IP) at Squarespace, exactly as in
[step 6](#6-dns-at-squarespace) but with Host **`api.stacker`**:

| Field | Value |
| --- | --- |
| Type | **A** |
| Host | **`api.stacker`** |
| Data | **`204.168.150.104`** |

```bash
dig +short api.stacker.tetrisatuci.org      # must print 204.168.150.104
```

### 10c. Run the API stack

The API is Dockerized (`server/`, orchestrated by the root `docker-compose.yml` +
`Makefile`). Requires Docker + Compose on the box. Create the prod `.env` at the
**repo root** (Compose reads it) from `.env.example`, with real secrets:

```bash
cd ~/ThomasTheDankEngineCode/Stacker
cp .env.example .env        # if not present
# then edit .env — the values that MUST change from the dev defaults:
```

```dotenv
DISCORD_CLIENT_ID=<real client id>
DISCORD_CLIENT_SECRET=<real client secret>
DISCORD_REDIRECT_URI=https://api.stacker.tetrisatuci.org/auth/callback/discord
JWT_SECRET=<paste `openssl rand -hex 32`>          # NEVER the dev default
FRONTEND_ORIGIN=https://stacker.tetrisatuci.org    # CORS + post-login redirect
COOKIE_SAMESITE=none                                # cross-subdomain
COOKIE_SECURE=true                                  # HTTPS-only cookie
UVICORN_RELOAD=                                     # empty → no dev file-watcher
```

Leave the Postgres/MinIO values as-is unless you're pointing at external stores.
Then bring it up (this also runs DB migrations):

```bash
make up                              # docker compose up -d --build (api on :8000)
curl -s localhost:8000/health        # → {"status":"ok","database":"ok"}
```

Compose publishes the API on `127.0.0.1:8000`. It stays loopback-local behind
Nginx — don't open 8000 in the firewall.

> **Boot persistence:** `db`, `minio`, and `api` carry `restart: unless-stopped`
> in `docker-compose.yml`, so they come back after a host reboot (and stay down
> after an explicit `make down`). Just make sure Docker itself starts on boot:
> `sudo systemctl enable docker`. The empty `UVICORN_RELOAD=` above drops the dev
> autoreload watcher for a stabler prod worker.

### 10d. Nginx block for the API

Add a **new** server block `/etc/nginx/sites-available/stacker-api` (don't touch
the app's block):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name api.stacker.tetrisatuci.org;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # so the app knows it's HTTPS
    }
}
```

Enable, test, reload, then add TLS (Secure cookies require it):

```bash
sudo ln -s /etc/nginx/sites-available/stacker-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.stacker.tetrisatuci.org   # choose "redirect"
```

### 10e. Rebuild the frontend to point at the API

The app's API base is compiled in, so rebuild with `VITE_API_URL` set, then reload
the static server (per [step 9](#9-redeploying-after-code-changes)):

```bash
cd ~/ThomasTheDankEngineCode/Stacker
VITE_API_URL=https://api.stacker.tetrisatuci.org npm run build
pm2 reload stacker
```

> Bake this into `deploy.sh` so redeploys keep the API URL:
> `VITE_API_URL=https://api.stacker.tetrisatuci.org npm run build`.

### 10f. Verify end to end

1. `https://api.stacker.tetrisatuci.org/health` → `{"status":"ok",...}`.
2. Open `https://stacker.tetrisatuci.org`, click **Log in** → you're sent to
   Discord, authorize, and land back on `/train` **logged in** (your name shows in
   the nav). If you bounce back logged-*out*, it's the cookie attributes — recheck
   `COOKIE_SAMESITE=none`, `COOKIE_SECURE=true`, and that the API is on HTTPS
   (see [troubleshooting](#operating--troubleshooting)).

### 10g. Redeploying the API

```bash
cd ~/ThomasTheDankEngineCode/Stacker
git pull
make up            # rebuilds the api image, re-runs migrations, restarts
```

---

## Operating & troubleshooting

| Task | Command |
| --- | --- |
| Status of all processes | `pm2 status` |
| Live logs | `pm2 logs stacker` |
| Last 200 log lines | `pm2 logs stacker --lines 200` |
| Restart | `pm2 restart stacker` |
| Stop / delete from PM2 | `pm2 stop stacker` / `pm2 delete stacker` |
| Resource usage (CPU/RAM) | `pm2 monit` |
| Re-persist after changes | `pm2 save` |

**`stacker` crash-loops (`online`↔`errored`, `↺` climbing fast)** — PM2 launched
`serve` wrong. `pm2 logs stacker` shows either `starting in -cluster mode-` or a
script path ending in `pm2/lib/API/Serve.js`. Fix the ecosystem file: `script` must
be the **absolute** path from `which serve`, and `exec_mode: "fork"` must be set
(see [step 4](#4-add-it-under-pm2)). Then
`pm2 delete stacker && pm2 start ecosystem.config.cjs`.

**Browser: "DNS address could not be found" / `DNS_PROBE_POSSIBLE`** — the name
doesn't resolve; nothing reached the server. `dig +short stacker.tetrisatuci.org`
from your laptop should print the server IP. If empty, the A record is missing or
not propagated (see [step 6](#6-dns-at-squarespace)). Also make sure the URL's
hostname exactly matches the Nginx `server_name` — a `.org`/`.com` mismatch fails
here too.

**App loads but shows 502 Bad Gateway** — Nginx can't reach the app. Almost always a
**port mismatch** between `ecosystem.config.cjs` (`-l <port>`) and Nginx
(`proxy_pass …:<port>`). Confirm they're equal, then check `pm2 status` (is
`stacker` online?) and `curl -I http://127.0.0.1:<port>`. If the curl fails, the
process is down — `pm2 logs stacker` for why.

**404 on a deep link / refresh** — SPA fallback missing. Confirm `serve` runs with
`-s` (single-page mode) in the ecosystem file; `-s` rewrites unknown paths to
`index.html`.

**Blank page, JS console errors about `node:` modules or `chalk`** — you're serving
a stale/broken build. Rebuild (`npm run build`) and `pm2 reload stacker`. The Vite
config already aliases `chalk` to a browser shim, so a correct build never ships it.

**Build gets "Killed"** — out of memory. Add swap (see the box in
[step 2](#2-build-the-app)).

**`pm2 status` empty after reboot** — the startup hook isn't installed. Run
`pm2 startup systemd`, execute the exact `sudo env … pm2 startup` line it prints,
then `pm2 save` (see [step 5](#5-make-pm2-survive-reboots)).

**One of the *other* apps disappeared** — a `pm2 delete all`/`pm2 kill`/stale
`pm2 resurrect` was run. Recover from the saved dump: `pm2 resurrect` (reads
`~/.pm2/dump.pm2`), or start each app's own ecosystem file again, then `pm2 save`.

### API / Discord login ([step 10](#10-optional-api-service--discord-login))

**Login "works" but the app shows you logged out** — the session cookie isn't
being sent back. Almost always the cross-subdomain cookie attributes: the API
`.env` must have `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true`, and the API must
be served over **HTTPS** (a `Secure` cookie is dropped on plain HTTP). In the
browser devtools, the `session` cookie should show `SameSite=None; Secure`.

**Discord: "Invalid OAuth2 redirect_uri"** — the `DISCORD_REDIRECT_URI` in the
API `.env` doesn't *exactly* match a URL registered in the Discord app's
**Redirects** list (scheme, host, and path all count). Add
`https://api.stacker.tetrisatuci.org/auth/callback/discord` there
(see [10a](#10a-create-the-discord-application)).

**CORS error in the console on `/me` or publish** — the API's `FRONTEND_ORIGIN`
must equal the app's exact origin (`https://stacker.tetrisatuci.org`, no trailing
slash). It's reflected into `Access-Control-Allow-Origin` with credentials; a
mismatch blocks the response.

**Login button does nothing / network error to `localhost:8000`** — the frontend
was built without `VITE_API_URL`, so it's calling `http://localhost:8000`. Rebuild
with `VITE_API_URL=https://api.stacker.tetrisatuci.org` and `pm2 reload stacker`
(see [10e](#10e-rebuild-the-frontend-to-point-at-the-api)).

**`api.stacker…/health` fails / 502** — the Compose stack isn't up or Nginx can't
reach it. `docker compose ps` (all healthy?), `curl -s localhost:8000/health` on
the box, and `docker compose logs api` for errors.

---

## Appendix A — server hardening (if not already done)

This box is already set up with a non-root user and other running sites, so hardening
is likely in place. For reference, the baseline is: SSH key-only login (no root, no
passwords) and automatic security updates:

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

---

## Appendix B — Nginx-only (no PM2)

Since this is a static SPA, the leanest setup is to let Nginx serve `dist/`
directly — no Node process, no port, and none of the nvm/`serve`/cluster pitfalls
above. If you don't need `stacker` in `pm2 status` alongside the other apps, use
this instead of steps 1, 3, 4, 5 — point the server block at the built files:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name stacker.tetrisatuci.org;

    root /home/betanine/ThomasTheDankEngineCode/Stacker/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;   # SPA fallback
    }

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
```

> Nginx (running as `www-data`) must be able to read the path. Home directories are
> often `0750`, so grant traverse access: `chmod o+x /home/betanine` (and ensure
> `dist/` is world-readable). Then do steps 2 (build), 6 (DNS), 7 (enable +
> TLS) and 8 (firewall). To redeploy, just rebuild — Nginx serves the new files
> immediately, no `pm2 reload`.

Then run steps 6–8 as written (skip `pm2 reload` in step 8 — just rebuild; Nginx
serves the new files immediately). This has fewer moving parts and no port 3000, at
the cost of dropping PM2 from the stack.

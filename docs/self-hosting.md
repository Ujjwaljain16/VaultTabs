# Self-hosting VaultTabs

Self-hosting is a first-class way to run VaultTabs: you control the server that sees your metadata and the
JavaScript the dashboard runs. A deployment consists of:

- **Postgres** (13+; 16 or 17 recommended),
- the **backend** API (Fastify, Node 22),
- the **PWA** dashboard (Next.js), and
- the **browser extension**, built against your API URL.

Contents:

- [Quickstart with Docker Compose](#quickstart-with-docker-compose)
- [TLS with a reverse proxy (Caddy)](#tls-with-a-reverse-proxy-caddy)
- [Environment reference](#environment-reference)
- [Building the extension for your server](#building-the-extension-for-your-server)
- [Publishing to the stores](#publishing-to-the-stores)
- [Backups](#backups)
- [Upgrades and migrations](#upgrades-and-migrations)
- [Scaling](#scaling)
- [Running without Docker](#running-without-docker)

## Quickstart with Docker Compose

Requirements: Docker with Compose v2 (v2.24+ for the production override file).

```bash
git clone https://github.com/Ujjwaljain16/VaultTabs.git
cd VaultTabs
cp .env.example .env
# Fill in at least POSTGRES_PASSWORD and JWT_SECRET. Generate values with:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# (or: openssl rand -hex 32)

docker compose up -d --build
docker compose ps          # wait until backend and pwa are healthy
curl http://localhost:3000/health
```

- PWA: <http://localhost:3001>, API: <http://localhost:3000/api/v1>.
- The backend applies database migrations automatically on start.
- Postgres is published on `127.0.0.1` only; the production override (`docker-compose.prod.yml`) does not
  publish it at all.
- Old snapshots and expired send-tab requests are pruned by the backend's built-in cleanup job.

For a public deployment, set the public URLs in `.env` **before** building, because `NEXT_PUBLIC_*` values
are compiled into the PWA:

```dotenv
NEXT_PUBLIC_API_URL=https://api.vault.example.com/api/v1
ALLOWED_ORIGINS=https://vault.example.com,chrome-extension://<your-extension-id>,moz-extension://*
TRUST_PROXY=true
```

and start with the production override:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The containers speak plain HTTP. **Always put TLS in front of them** before exposing them beyond
`localhost`: browsers only allow WebCrypto on secure origins, and tokens must never cross the network in
clear text.

## TLS with a reverse proxy (Caddy)

[Caddy](https://caddyserver.com) obtains and renews Let's Encrypt certificates automatically. Point two DNS
records (e.g. `vault.example.com` and `api.vault.example.com`) to your server and use:

```caddyfile
# /etc/caddy/Caddyfile
vault.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3001
}

api.vault.example.com {
	encode zstd gzip
	# Server-Sent Events (/api/v1/restore/stream) must not be buffered.
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
```

Notes:

- Set `TRUST_PROXY=true` on the backend so rate limiting and logs use the client IP from
  `X-Forwarded-For`. Only do this when the backend is reachable **only** through the proxy (bind the
  container ports to `127.0.0.1`, or remove the port mappings and put Caddy on the compose network).
- Keep idle timeouts above 30 seconds; the SSE stream sends a keep-alive comment every 20 seconds.
- A single domain also works (`/api/*` to the backend, everything else to the PWA); then
  `NEXT_PUBLIC_API_URL=https://vault.example.com/api/v1`.
- nginx: disable `proxy_buffering` for the API location and set `proxy_read_timeout` to a few minutes.
- Alternatively the backend can serve HTTPS itself: set `TLS_CERT_FILE` and `TLS_KEY_FILE` to PEM files
  (mounted read-only into the container).

## Environment reference

### Docker Compose (`.env` at the repository root)

| Variable              | Required | Description                                                                           |
| --------------------- | -------- | ------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`   | yes      | Password of the bundled Postgres user. Long and random.                               |
| `JWT_SECRET`          | yes      | Token signing secret, >= 32 random characters.                                        |
| `NEXT_PUBLIC_API_URL` | no       | Public API URL baked into the PWA image (default `http://localhost:3000/api/v1`).     |
| others                | no       | Any backend variable below that the compose file passes through (see `.env.example`). |

### Backend

| Variable                         | Default                    | Description                                                                                                                                                                                                       |
| -------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | — (required)               | `postgres://user:pass@host:5432/db`                                                                                                                                                                               |
| `DATABASE_SSL`                   | `require`                  | `require`: TLS with certificate verification. `insecure`: TLS without verification (avoid). `disable`: no TLS (only for a private network/localhost).                                                             |
| `DATABASE_POOL_MAX`              | `10`                       | Max connections per backend instance (1-100).                                                                                                                                                                     |
| `JWT_SECRET`                     | — (required)               | >= 32 characters; placeholder-looking values are rejected. Changing it signs everyone out.                                                                                                                        |
| `JWT_EXPIRY`                     | `30d`                      | Token lifetime: `3600s`, `60m`, `12h`, `30d`, `2w`.                                                                                                                                                               |
| `HOST`                           | `0.0.0.0`                  | Bind address.                                                                                                                                                                                                     |
| `PORT`                           | `3000`                     | Listen port.                                                                                                                                                                                                      |
| `ALLOWED_ORIGINS`                | empty                      | Comma-separated CORS origins (exact, or `*` wildcard patterns such as `moz-extension://*`). Empty allows any origin in development and **none** in production. Include your PWA URL and your extension origin(s). |
| `TRUST_PROXY`                    | `false`                    | `true` behind a reverse proxy that sets `X-Forwarded-For`.                                                                                                                                                        |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | unset                      | PEM certificate and key to serve HTTPS directly. Set both or neither.                                                                                                                                             |
| `MAX_DEVICES_PER_USER`           | `25`                       | Device limit per account.                                                                                                                                                                                         |
| `CLEANUP_INTERVAL_MINUTES`       | `60`                       | Interval of the in-process cleanup job (retention, expired requests). `0` disables it.                                                                                                                            |
| `PRELOGIN_SECRET`                | derived from `JWT_SECRET`  | >= 32 characters. Key for the deterministic fake prelogin/recovery data for unknown emails. Set it explicitly if you want to rotate `JWT_SECRET` without changing those values.                                   |
| `LOG_LEVEL`                      | `info` (`silent` in tests) | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. Secrets are redacted.                                                                                                                               |
| `NODE_ENV`                       | `production`               | `development` enables pretty logs and permissive CORS.                                                                                                                                                            |

### PWA (build time)

| Variable                             | Description                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`                | Public API URL, e.g. `https://api.vault.example.com/api/v1`. Baked in at build time.              |
| `NEXT_PUBLIC_EXTENSION_DOWNLOAD_URL` | Optional link for the "get the extension" button (store page or release zip).                     |
| `NEXT_PUBLIC_REPO_URL`               | Optional link to the source code shown in the UI (point it to your fork if you changed the code). |

### Extension (build time)

| Variable                    | Description                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `VITE_API_URL`              | **Required for production builds.** Your API URL. It becomes the extension's only host permission. |
| `VITE_DASHBOARD_URL`        | URL of your PWA, opened from the popup.                                                            |
| `VITE_FIREFOX_EXTENSION_ID` | Gecko add-on id for Firefox builds (e.g. `vaulttabs@example.com`). Required to publish on AMO.     |

## Building the extension for your server

```bash
npx -y npm@11 install            # npm 10.9 cannot install this workspace, see CONTRIBUTING.md
npm run build:shared

export VITE_API_URL=https://api.vault.example.com/api/v1
export VITE_DASHBOARD_URL=https://vault.example.com
export VITE_FIREFOX_EXTENSION_ID=vaulttabs@example.com   # Firefox only

npm run build --workspace=extension           # Chrome  -> extension/.output/chrome-mv3/
npm run build:firefox --workspace=extension   # Firefox -> extension/.output/firefox-*/
npm run zip --workspace=extension             # zips in extension/.output/
npm run zip:firefox --workspace=extension
```

(On Windows PowerShell use `$env:VITE_API_URL = "..."`, or put the values in `extension/.env.production.local`.)

Then add the extension's origin to the backend's `ALLOWED_ORIGINS` (`chrome-extension://<id>` - the id is
shown on `chrome://extensions`; for Firefox `moz-extension://*` or the specific UUID).

**Load it locally:**

- Chrome / Edge / Brave: open `chrome://extensions`, enable _Developer mode_, _Load unpacked_, select
  `extension/.output/chrome-mv3`. The id of an unpacked extension depends on its path; set a `key` in the
  manifest or publish it to get a stable id.
- Firefox: open `about:debugging#/runtime/this-firefox`, _Load Temporary Add-on_, select the `manifest.json`
  in the Firefox output folder. Temporary add-ons are removed on restart; for permanent use, sign the zip
  on AMO (it can be _unlisted_, i.e. self-distributed).

Tagged releases of this repository also attach prebuilt zips; those are built for the maintainers' API URL
(see the release notes), so self-hosters should build their own.

## Publishing to the stores

- **Chrome Web Store**: upload the Chrome zip in the developer dashboard. Justify each permission (tabs:
  reading open tabs to sync them; storage; the single host permission for your API). Link to
  [docs/security-model.md](security-model.md) as the privacy explanation and provide a privacy policy that
  lists the metadata your server sees.
- **addons.mozilla.org**: set `VITE_FIREFOX_EXTENSION_ID` before building, upload the Firefox zip, and also
  upload the source code archive (`wxt zip -b firefox` produces a `*-sources.zip`) with build instructions
  (this page), as required for bundled code.
- Use your own extension name/branding if your build talks to your own server, so users are not confused
  with other instances.

## Backups

Only Postgres holds state. Everything sensitive in it is either ciphertext or a hash, but it still contains
emails and metadata, so protect backups like the live database.

```bash
# Dump (custom format, compressed)
docker compose exec -T postgres pg_dump -U vaulttabs -d vaulttabs -Fc > vaulttabs-$(date +%F).dump

# Restore into an empty database
docker compose exec -T postgres pg_restore -U vaulttabs -d vaulttabs --clean --if-exists < vaulttabs-2026-11-16.dump
```

Keep `JWT_SECRET` (and `PRELOGIN_SECRET` if set) with your secrets, not in the backups. Losing them only
signs users out; losing the database loses all data. Users who lose both their password and recovery code
cannot be helped by any backup: that is the point of end-to-end encryption.

## Upgrades and migrations

```bash
git pull                       # or check out a release tag
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

- Migrations are versioned SQL files tracked in the `schema_migrations` table. The backend container runs
  pending migrations on start; outside Docker run `npm run db:migrate --workspace=backend`.
  Migrations are forward-only: **take a backup before upgrading.**
- Read [CHANGELOG.md](../CHANGELOG.md) for breaking changes. Upgrade the backend first, then the PWA, then
  publish the new extension build; the backend accepts the previous extension release during the
  transition.
- The backend shuts down gracefully on `SIGTERM` (finishes in-flight requests, closes SSE streams and the
  database pool), so rolling restarts are safe.
- Upgrading to 1.0.0 from earlier versions: users of legacy (v1) accounts are upgraded automatically at
  their next login; the `fingerprint` column and plaintext send-tab URLs are no longer used.

## Scaling

- The backend is stateless apart from Postgres. You can run several instances behind a load balancer.
- Real-time "send tab" delivery uses Postgres `LISTEN/NOTIFY`, so an SSE client connected to instance A is
  notified when the request is created on instance B. Each instance holds one listening connection in
  addition to its pool.
- **Rate limits are kept in memory per instance**, so N instances allow N times the configured rate.
  Enforce limits at the proxy/WAF as well if that matters.
- Run the cleanup job on one instance (`CLEANUP_INTERVAL_MINUTES=0` on the others) to avoid duplicate work.
  Running it on several is safe, just wasteful.
- Keep `DATABASE_POOL_MAX` x instances (plus one listener connection each) below Postgres'
  `max_connections`.
- Use `/health` for liveness and `/ready` (checks the database) for readiness probes.

## Running without Docker

```bash
npx -y npm@11 install
npm run build                                  # shared, backend, pwa, extension

cd backend
cp .env.example .env                           # DATABASE_URL, JWT_SECRET, NODE_ENV=production, ...
npm run start                                  # runs migrations, then the server

cd ../pwa
NEXT_PUBLIC_API_URL=https://api.vault.example.com/api/v1 npm run build
npm run start                                  # port 3001
```

Use a process manager (systemd, pm2) and the same reverse proxy setup as above.

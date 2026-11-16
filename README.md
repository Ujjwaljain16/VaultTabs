<div align="center">
  <img src="pwa/public/icon-512.png" width="120" alt="VaultTabs logo" />

# VaultTabs

**End-to-end encrypted tab sync across browsers. Self-hostable. Open source.**

[![CI](https://github.com/Ujjwaljain16/VaultTabs/actions/workflows/ci.yml/badge.svg)](https://github.com/Ujjwaljain16/VaultTabs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Security model](https://img.shields.io/badge/security-model-00aa66.svg)](docs/security-model.md)

</div>

VaultTabs keeps the open tabs of all your browsers (Chrome, Edge, Brave, Firefox) in sync and lets you send
tabs between them. Your tab list is encrypted on your device with a key the server never sees, so the server
stores only ciphertext. Your password never leaves your device either.

- **Browser extension** captures your tabs, encrypts them and syncs them.
- **Web dashboard (PWA)** decrypts them locally: browse, search, restore and send tabs from anywhere.
- **Backend** (Fastify + Postgres) stores ciphertext and relays messages between your devices in real time.

## Features

- Cross-device tab sync, with every device's current tabs in one place
- Send a tab, a window or a whole snapshot to another device, delivered in real time
- Search across the tabs of all your devices
- Snapshot history ("time travel") with a diff between snapshots
- Saved sessions with encrypted names, never pruned
- Export as JSON or as a bookmarks HTML file
- Change password, regenerate recovery code, sign out everywhere, configurable retention
- PWA auto-lock and a "don't remember this device" mode; per-domain never-sync list in the extension
- Self-hosting with Docker Compose; one versioned API contract shared by all components

## Security at a glance

| What                                                        | Protected?                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Tab URLs, titles, favicons, window layout                   | **End-to-end encrypted** (AES-256-GCM, bound to user/device/time) |
| URLs you send to another device                             | **End-to-end encrypted**, bound to the target device              |
| Saved-session names                                         | **End-to-end encrypted**                                          |
| Your password, master key, recovery code                    | **Never sent** to the server                                      |
| Email, device names, timestamps, snapshot sizes, IP address | Visible to the server operator                                    |
| Which device sent tabs to which device, and when            | Visible to the server operator                                    |

How it works: your password goes through PBKDF2-SHA256 (600,000+ iterations) and HKDF on your device. One
derived value logs you in; a separate one, which never leaves your device, unlocks a random master key that
encrypts your data. A recovery code (100 bits) is the only way back if you forget your password.

Be aware of the limits: the server sees metadata; the **web dashboard's code is served by the server
operator**, so a malicious operator could ship malicious JavaScript (true for any web crypto app). The
extension, whose code is fixed at install time, is the stronger client, and self-hosting removes the need to
trust anyone else. Registration reveals whether an email is already registered. Full details, parameters and
known limitations: **[docs/security-model.md](docs/security-model.md)**.

Found a vulnerability? Please report it privately, see [SECURITY.md](SECURITY.md).

## Quickstart (self-hosted)

Requirements: Docker with Compose v2, Node.js 22 and npm 11 (only for building the extension).

```bash
git clone https://github.com/Ujjwaljain16/VaultTabs.git
cd VaultTabs

# 1. Configure: set POSTGRES_PASSWORD and JWT_SECRET (and your public URLs for a real deployment)
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # use for each secret

# 2. Start Postgres, the API (:3000) and the dashboard (:3001); migrations run automatically
docker compose up -d --build

# 3. Build the extension against your API
npx -y npm@11 install
npm run build:shared
VITE_API_URL=http://localhost:3000/api/v1 VITE_DASHBOARD_URL=http://localhost:3001 \
  npm run build --workspace=extension        # or build:firefox
```

Load `extension/.output/chrome-mv3` via `chrome://extensions` → Developer mode → _Load unpacked_ (Firefox:
`about:debugging` → _Load Temporary Add-on_), create an account in the extension or at
<http://localhost:3001>, and **store the recovery code** you are shown.

For anything beyond localhost, put a TLS reverse proxy in front (browsers require HTTPS for WebCrypto). The
[self-hosting guide](docs/self-hosting.md) covers Caddy, all environment variables, publishing the extension,
backups, upgrades and scaling.

> **Hosted instance:** the maintainer may run a demo instance at
> [vaulttabs.vercel.app](https://vaulttabs.vercel.app). It is optional and provided as is; self-hosting is
> the recommended, first-class way to use VaultTabs.

## Development

```bash
npx -y npm@11 install      # npm 10.9 crashes on this workspace tree; use npm 11
npm run build:shared

npm run dev --workspace=backend      # API on :3000 (needs Postgres + backend/.env)
npm run dev --workspace=pwa          # dashboard on :3001
npm run dev --workspace=extension    # opens a browser with the extension (dev:firefox for Firefox)

npm run lint && npm run format:check && npm run typecheck && npm test
```

Backend tests need a Postgres database they may wipe (`TEST_DATABASE_URL`). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full setup, conventions and the policy for API and crypto
changes.

## Repository layout

```text
shared/      @vaulttabs/shared: types, API contract (api.ts), all client-side crypto (crypto.ts)
backend/     Fastify 5 API, Postgres migrations, cleanup job, SSE
pwa/         Next.js 16 dashboard (PWA)
extension/   WXT browser extension (Chrome MV3, Firefox)
docker/      Postgres init SQL for Docker Compose
docs/        Architecture, security model, self-hosting and API docs
```

## Documentation

- [Architecture](docs/architecture.md): components, data flow, sequence diagrams, schema
- [Security model](docs/security-model.md): threat model, cryptography, limitations
- [Self-hosting](docs/self-hosting.md): Docker, TLS, configuration, extension builds, operations
- [API](docs/api.md): HTTP endpoints
- [Changelog](CHANGELOG.md)

## Contributing

Contributions are welcome! Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Please discuss cryptography changes in an issue before writing code.

## License

[MIT](LICENSE) © 2026 Ujjwal Jain and VaultTabs contributors

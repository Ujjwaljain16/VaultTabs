# Contributing to VaultTabs

Thanks for your interest in improving VaultTabs! Bug reports, docs fixes, features and security reviews are
all welcome. By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

- **Security issues:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Bugs and feature ideas:** open an issue using one of the templates. For larger changes, please open an
  issue first so we can agree on the approach before you invest time.

## Repository layout

| Path         | What it is                                                                          |
| ------------ | ----------------------------------------------------------------------------------- |
| `shared/`    | `@vaulttabs/shared`: domain types, the HTTP API contract and all client-side crypto |
| `backend/`   | Fastify 5 API server + Postgres (migrations, cleanup job, SSE)                      |
| `pwa/`       | Next.js 16 web dashboard (installable PWA)                                          |
| `extension/` | WXT browser extension (Chrome MV3, Firefox)                                         |
| `docker/`    | Postgres init SQL used by Docker Compose                                            |
| `docs/`      | Architecture, security model, self-hosting and API docs                             |

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Prerequisites

- **Node.js 22** (>= 20.9 works; `.nvmrc` pins 22, so `nvm use` / `fnm use` picks it up).
- **npm 11.** npm 10.9 crashes while resolving this workspace tree
  (`Cannot read properties of null (reading 'edgesOut')`). Either install it globally
  (`npm i -g npm@11`) or prefix commands with `npx -y npm@11`. We do not set `packageManager` in
  `package.json` because Corepack is not enabled by default for npm, and an enforced pin would get in the way
  of contributors who already run a newer npm.
- **PostgreSQL 13+** (16/17 recommended), either installed locally or via Docker.
- Optional: Docker with Compose v2 to run the full stack, Chrome and/or Firefox for the extension.

## Setup

```bash
git clone https://github.com/Ujjwaljain16/VaultTabs.git
cd VaultTabs
npx -y npm@11 install          # or: npm install (if your global npm is 11+)
npm run build:shared           # backend, extension and PWA import the compiled @vaulttabs/shared
```

Rebuild `shared` (`npm run build:shared`) whenever you change it; the other workspaces consume its `dist/`.

### Database

Pick one:

```bash
# A) Only Postgres from Docker Compose (bound to 127.0.0.1:5432)
cp .env.example .env            # fill in POSTGRES_PASSWORD and JWT_SECRET
docker compose up -d postgres

# B) A local Postgres
createdb vaulttabs
createdb vaulttabs_test         # for the backend integration tests
```

### Environment files

Every app has an `.env.example`. Copy it and adjust; never commit the real files (`.gitignore` blocks them).

| File                   | Copy from                | Minimum to set                                                                          |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `backend/.env`         | `backend/.env.example`   | `DATABASE_URL`, `DATABASE_SSL=disable` (local), `JWT_SECRET` (>= 32 chars)              |
| `pwa/.env.local`       | `pwa/.env.example`       | `NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1`                                      |
| `extension/.env.local` | `extension/.env.example` | `VITE_API_URL=http://localhost:3000/api/v1`, `VITE_DASHBOARD_URL=http://localhost:3001` |

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. All
variables are documented in [docs/self-hosting.md](docs/self-hosting.md#environment-reference).

WebCrypto requires a secure context. `http://localhost` counts as secure, so plain HTTP on localhost is fine
for development. To test from another device on your network, use HTTPS (e.g. a reverse proxy, or
`TLS_CERT_FILE` / `TLS_KEY_FILE` for the backend and `npm run dev:https --workspace=pwa`).

### Running the apps

```bash
# Backend API on :3000 (applies migrations first)
npm run db:migrate --workspace=backend
npm run dev --workspace=backend

# PWA on :3001
npm run dev --workspace=pwa

# Extension (opens a browser with the extension loaded; restart after changing .env files)
npm run dev --workspace=extension             # Chrome
npm run dev:firefox --workspace=extension     # Firefox
```

Or run the whole stack in containers: `docker compose up -d --build` (see
[docs/self-hosting.md](docs/self-hosting.md)).

## Checks

Run these before opening a pull request; CI runs the same commands.

```bash
npm run lint            # ESLint (flat config in eslint.config.mjs)
npm run format:check    # Prettier
npm run typecheck       # builds shared, then type-checks every workspace
npm test                # Vitest: projects "shared" and "backend"
npm run build           # builds everything
```

`npm run lint:fix` and `npm run format` apply automatic fixes.

### Tests

Tests use [Vitest](https://vitest.dev) with the root `vitest.config.mts`:

- `shared` — crypto and contract unit tests (`shared/src/**/*.test.ts`), no services needed.
- `backend` — integration tests (`backend/test/**/*.test.ts`) against a real Postgres. They need a
  **dedicated** database that they are allowed to wipe:

```bash
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/vaulttabs_test
export DATABASE_SSL=disable
npm test                                   # everything
npx vitest run --project shared            # only the shared tests
```

A throwaway Postgres for tests:
`docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=vaulttabs_test postgres:17-alpine`.

Please add tests for bug fixes and new behavior, especially for anything touching auth, authorization or
crypto.

## Code style

- TypeScript everywhere, ES modules, `strict` mode.
- Prettier formats the code (`singleQuote`, `printWidth: 110`, `trailingComma: all`); do not hand-format.
- ESLint: no unused variables (prefix intentionally unused ones with `_`), avoid `any`, prefer
  `import type` for types, no `console.log` outside backend scripts (use the Fastify/pino logger in the
  backend).
- Keep comments about _why_, not _what_. Security-relevant decisions deserve a comment.
- Never log secrets, tokens, keys, `auth_key`, recovery material or decrypted tab data.

## Commits and pull requests

- Branch from `main`; keep pull requests focused on one change.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and PR titles, with
  the workspace as scope when it helps:
  `feat(extension): add per-domain never-sync list`, `fix(backend): reject foreign device ids`,
  `docs: explain rollback detection`. Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`, `security`. Mark breaking changes with `!` (`feat(shared)!: ...`) and explain them in the
  body.
- Fill in the pull request template, link related issues (`Fixes #123`), and add an entry under
  `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- CI must be green. A maintainer will review; please be patient and responsive to feedback.
- Do not commit generated files (`dist/`, `.next/`, `.output/`, extension zips) or any `.env` file,
  certificate or private key.

## Changing the API contract (`shared/`)

`shared/src/api.ts` (routes, payloads, responses, `LIMITS`) and `shared/src/models.ts` are the single
source of truth used by the backend, the PWA and the extension. When you change them:

1. Edit the types in `shared/` first, then run `npm run typecheck`: the compiler shows every consumer that
   has to change.
2. Update the backend route validation (zod schemas) and handlers, the PWA and the extension in the **same
   pull request**, so `main` is always consistent.
3. Prefer additive, backwards-compatible changes (new optional fields, new endpoints). Extensions in users'
   browsers update on the store's schedule, so the server must keep accepting the previous extension
   release for a while. Breaking changes need a new API version or a migration path, and a CHANGELOG entry.
4. Database changes go into a **new** numbered migration; never edit a migration that has been released.
5. Update [docs/api.md](docs/api.md) (and [docs/architecture.md](docs/architecture.md) if flows change).

## Changing cryptography

Crypto mistakes are silent and permanent (users' data is encrypted with what we ship), so the bar is higher:

- All client-side crypto lives in `shared/src/crypto.ts`. Do not implement crypto in the extension or the
  PWA directly, and only use WebCrypto (no third-party crypto libraries without prior discussion).
- **Open an issue before writing code** for any change to key derivation, key wrapping, ciphertext
  formats, AAD strings, the recovery-code scheme or the authentication protocol. Describe the threat it
  addresses and the migration path.
- Never change the meaning of an existing version. New formats get a new version number (`kdf_version`,
  `enc_version`, AAD prefix such as `vaulttabs/snapshot/v3`), and clients must keep decrypting old versions
  until a documented migration has removed them.
- Domain-separate every new key or ciphertext type (distinct HKDF `info` / AAD prefix).
- Include test vectors or round-trip and tamper tests (wrong AAD, wrong key, modified ciphertext must fail).
- Update [docs/security-model.md](docs/security-model.md) in the same pull request; it must always describe
  what the code actually does, including limitations.
- Crypto-related pull requests need review from a maintainer, and ideally a second reviewer.

## Releasing (maintainers)

1. Update `CHANGELOG.md` (move `[Unreleased]` to a new version) and bump `version` in the workspace
   `package.json` files.
2. Tag: `git tag v1.2.3 && git push origin v1.2.3`.
3. The [release workflow](.github/workflows/release.yml) builds the Chrome and Firefox extension zips with
   the repository variable `VITE_API_URL`, attaches them to a GitHub Release and publishes the backend and
   PWA images to GHCR.
4. Upload the zips to the Chrome Web Store / addons.mozilla.org as described in
   [docs/self-hosting.md](docs/self-hosting.md#publishing-to-the-stores).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

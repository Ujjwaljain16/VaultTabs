## Summary

<!-- What does this PR change and why? Link issues: "Fixes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change (API contract, data format, configuration)
- [ ] Documentation / tooling only

## Components

- [ ] `shared` (types / API contract / crypto)
- [ ] `backend`
- [ ] `pwa`
- [ ] `extension`
- [ ] Docker / CI / docs

## Checklist

- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck` and `npm test` pass locally
- [ ] Tests added or updated for the change
- [ ] API contract changes are made in `shared/` and all consumers are updated in this PR; `docs/api.md` updated
- [ ] Database changes are in a new migration (no edits to released migrations)
- [ ] `CHANGELOG.md` updated under `[Unreleased]` for user-visible changes
- [ ] No secrets, `.env` files, certificates or build output committed

## Security and privacy

<!--
Does this change what the server can see, authentication, sessions, or cryptography?
If it touches crypto, link the issue where the design was agreed and update docs/security-model.md.
-->

- [ ] No impact on security or privacy
- [ ] Security-relevant: explained below and `docs/security-model.md` updated

## How was this tested?

<!-- Browsers, steps, screenshots for UI changes. -->

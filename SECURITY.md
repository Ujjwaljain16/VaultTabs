# Security Policy

VaultTabs is an end-to-end encrypted tab sync tool, so security reports are taken seriously and handled
privately. The full threat model, cryptographic parameters and known limitations are documented in
[docs/security-model.md](docs/security-model.md). Please read it before reporting: behavior that is listed
there as a known limitation is not a vulnerability by itself (but ideas to remove a limitation are welcome as
regular issues or discussions).

## Supported versions

| Version                      | Supported                                                         |
| ---------------------------- | ----------------------------------------------------------------- |
| 1.x (latest release)         | Yes                                                               |
| `main` branch                | Yes (fixes land here first)                                       |
| < 1.0 (pre-release, auth v1) | No. Upgrade: legacy accounts are migrated automatically on login. |

Self-hosters should run the latest release of all three components (backend, PWA, extension). Security
fixes are not backported to older minor versions.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub Security Advisories:

1. Go to <https://github.com/Ujjwaljain16/VaultTabs/security/advisories/new>
   (Security tab, then "Report a vulnerability").
2. Describe the issue, the affected component(s) and version/commit, and steps to reproduce. A proof of
   concept is very helpful.
3. Tell us how you would like to be credited (or that you prefer to stay anonymous).

What to expect:

- Acknowledgement within **5 days**.
- An initial assessment (accepted / needs more info / out of scope) within **14 days**.
- For accepted issues we aim to ship a fix within **90 days**, coordinate a disclosure date with you, and
  publish a GitHub Security Advisory (with a CVE where appropriate) crediting you.

This is a volunteer-run project; there is no bug bounty.

## Scope

In scope:

- The backend API (`backend/`), PWA (`pwa/`), browser extension (`extension/`) and shared crypto/contract
  code (`shared/`) in this repository.
- The official Docker images, Docker Compose files and release artifacts (extension zips) built from this
  repository.
- Weaknesses in the cryptographic design described in [docs/security-model.md](docs/security-model.md), e.g.
  ways for the server to learn tab contents or keys, forge or relabel snapshots, or make a client open URLs
  the user did not send.
- Authentication and authorization bugs: account takeover, cross-account access, session revocation bypass,
  account/email enumeration beyond what is documented.

Out of scope:

- Limitations already documented in [docs/security-model.md](docs/security-model.md#known-limitations)
  (metadata visible to the server, served-JavaScript trust for the PWA, registration revealing whether an
  email exists, per-instance rate limits, ...).
- Vulnerabilities in a third-party hosted instance that are caused by its operator's configuration (missing
  TLS, weak `JWT_SECRET`, exposed database, ...). Report those to the operator.
- Attacks that require a fully compromised device or browser profile, malicious browser extensions with
  broader permissions, or physical access to an unlocked machine (see the threat model for what we do try
  to protect there).
- Denial of service through volumetric traffic, missing best-practice headers without a demonstrated
  impact, and reports generated only by automated scanners.
- Social engineering of maintainers or users.

## Historical note: leaked development certificates

Earlier commits of this repository contained locally generated mkcert development certificates **including
private keys** (`certs/*.pem`). They were only ever used for local development, have been removed from the
tree, and the backend no longer ships certificate tooling (TLS is configured with `TLS_CERT_FILE` /
`TLS_KEY_FILE` or terminated by a reverse proxy). Treat those keys as compromised: never trust them, and if
you installed the corresponding mkcert root CA on a machine, regenerate it (`mkcert -uninstall && mkcert
-install`). They are not a vulnerability in VaultTabs itself.

# Handoff: 1Password credentials node for n8n

Date: 2026-11-09
From: planning session in `~/Sites/credentials-hub` (empty folder, no code written)
To: new session in `~/Sites/n8n` (repo `Ka-Chava/n8n`, infrastructure and operations for the self-hosted n8n stack)

Status (updated 2026-11-09, end of session): route A confirmed by the user (separate repo, publish to npm, add to the n8n repo's locked package list). Version 0.1.0 is built in this folder but not committed, pushed or published. No 1Password changes, nothing deployed. See section 10 for what was built and verified, and what is left.

## 1. Goal

Build a community node that fetches credentials from Ka'Chava's central 1Password account and makes them usable by workflows on our self-hosted n8n instance.

- n8n edition: Community Edition (no Enterprise license).
- Topology: one n8n instance, many users (confirmed by the user).
- Ownership: a few admins create and rotate credentials in 1Password. Other n8n users consume them. The 1Password master account is never shared.
- Inspiration: the "Credential HUB" forum post (https://community.n8n.io/t/credential-hub-centralized-credential-management-for-self-hosted-automation/306153). It is a standalone Docker service that workflows call with the HTTP Request node, not an n8n node. Beta, no replies. We are not adopting it.

## 2. About the user

- The user is Ka'Chava's head of IT. Do not suggest helpdesk tickets or IT approvals. They approve and provision directly (1Password service accounts, vaults, tool registration).
- Approving a design is not approval to push, deploy, or provision. Ask separately for those (this matches the existing memory in the n8n project).

## 3. Verified facts (with sources)

- n8n already has this feature on Enterprise only. External Secrets supports a 1Password provider through a self-hosted 1Password Connect Server, added in n8n 2.12. Credential fields reference `$secrets.<vault>.<item>.<field>`. Source: n8n docs, "External secrets" and changelog (via Context7, `/n8n-io/n8n-docs`). Our node is a Community Edition substitute for it.
- 1Password JS SDK: `@1password/sdk`. `sdk.createClient({ auth: <service account token>, integrationName, integrationVersion })`, then `client.secrets.resolve("op://<vault>/<item>[/<section>]/<field>")`. It can throw `RateLimitExceededError` and `AuthExpiredError`. It contains a WASM core. Source: 1Password SDK docs (`/1password/onepassword-sdk-js`).
- n8n 3.0 changes the default of `N8N_UNVERIFIED_PACKAGES_ENABLED` to `false`. Source: n8n v3.0 breaking changes doc.
- Private nodes can be loaded from `N8N_CUSTOM_EXTENSIONS` in a custom image (n8n docs, "Install private nodes").

Internal (Confluence KB):
- "1Password - Getting Started & Security Guide": 1Password is provisioned through Microsoft Entra ID, and shared vaults are provisioned per team.
- "Responsible AI Use": automations built with tools such as N8N must be registered with IT. The user is IT, so this is theirs to record, not to request.

## 4. Repo findings that change the earlier advice

The planning session first recommended a custom Docker image with `N8N_CUSTOM_EXTENSIONS`. That was before it looked at this repo. The repo already has a different, established mechanism:

- `docker-compose.yml` runs the stock image `docker.n8n.io/n8nio/n8n:${N8N_VERSION}` (currently `2.45.7` in `.env.*.example`). There is no custom Dockerfile.
- Queue mode: main plus workers (`n8n-worker-1`, and `n8n-worker-2` in prod), each with its own volume. Every package must be present on main and all workers.
- Community packages are managed by env and a lockfile:
  - `community-packages/package.json` and `package-lock.json` list the pinned packages (currently `n8n-nodes-firecrawl`, `n8n-nodes-globals`, `n8n-nodes-mcp`).
  - `scripts/bootstrap-community-packages.sh` runs before n8n starts. It derives `N8N_COMMUNITY_PACKAGES` from the lock and runs `npm ci --omit=dev --ignore-scripts` into each volume, then verifies the install.
  - `N8N_COMMUNITY_PACKAGES_MANAGED_BY_ENV=true` keeps the UI read-only.
  - `N8N_UNVERIFIED_PACKAGES_ENABLED=false`. Locked packages still install because the manifest carries the lockfile's SHA-512 checksums.
  - Related tooling: `scripts/community-package-graph.js`, `scripts/check-community-packages.py`, and their tests.

Consequence: the most natural route is to publish the node as an npm package and add it to `community-packages/package.json`, so it goes through the existing lock, checksum, and reconciliation pipeline. A custom image would be a second, parallel mechanism.

Decision needed from the user:
- A. Public npm package (simplest fit with the pipeline; code becomes public, no secrets in it).
- B. Private npm registry or scope (for example GitHub Packages). Needs registry auth inside the bootstrap `npm ci`. Check how the bootstrap and `graph.js` handle a non-default registry.
- C. Custom image with `N8N_CUSTOM_EXTENSIONS` (the earlier advice; bypasses the existing pipeline).
- D. Possible, not verified: keep the node source inside this repo and reference it from `community-packages/package.json` as a `file:` tarball or git dependency, so it still goes through `npm ci` and lock verification without publishing anywhere. First check whether `scripts/community-package-graph.js` and the checker accept non-registry dependencies.

Recommendation (2026-11-09, waiting for the user to confirm): keep the node in its own repo (this `credentials-hub` folder can become it), publish it to npm, and add it to `community-packages/` in the n8n repo. The node repo owns build, unit tests, and releases. The n8n repo owns compatibility: the lock pins the node version, and every `N8N_VERSION` bump PR runs the smoke tests in section 7 against it. Public npm is the simplest fit. Use a private registry (route B) only if the code must stay private, because it adds registry auth to the bootstrap. Check whether n8n accepts a scoped name such as `@kachava/n8n-nodes-<name>`.

Local development uses OrbStack, not Docker Desktop (global user rule).

Earlier discussion of npm risks still applies: protect the npm account with 2FA, publish with provenance, and pin exact versions in the lock.

## 5. Agreed design

Package: standard community package named `n8n-nodes-<name>`, keyword `n8n-community-node-package`.

Contents:
- Credential type that holds a 1Password service account token.
- `1Password` node: operation "Resolve secret reference" that takes an `op://` reference and returns the value.
- `1Password HTTP Request` wrapper node: resolves the secret and makes the API call in one step. Preferred pattern, because the secret never enters item data.
- In-memory cache with a short TTL inside the node to stay under 1Password rate limits. Note: each main and worker process has its own cache.

Access model (one instance, many users):
- One 1Password service account per team, each with read access only to that team's vault.
- The user shares each team's token through 1Password. Each n8n user enters it once in the node's credential.
- Do not read a single token from a host environment variable. Every user on the instance could then read every vault that token reaches.

Security points to keep in the design and docs:
- Anything the node outputs is saved in execution history. Use the wrapper node, or turn off saving execution data for workflows that output secrets.
- Anyone who can build a workflow that uses a secret can send it to their own server. This is also true on n8n Enterprise. The design gives central management, vault-scoped access, rotation in one place, and a 1Password audit trail, not secrecy from workflow builders.
- Instance owners and admins can see all workflows and executions (general n8n behavior, not re-checked in docs this session).
- The package runs inside the n8n process with full host access (general knowledge, not re-checked). Pin versions and review every update.

## 6. Unverified, check before relying on it

- Whether `@1password/sdk` (WASM core) loads in the n8n container and installs correctly under `npm ci --ignore-scripts`. If it fails, the fallback is 1Password Connect Server (plain HTTP, extra container, same backend as n8n Enterprise External Secrets).
- 1Password service account rate limits for our plan.
- Whether `community-package-graph.js` and the checker accept a private registry or scoped package (only matters for option B).
- Whether credential fields accept expressions on Community Edition. Not needed for the design, so do not assume it.
- Whether n8n verification rules allow runtime dependencies. Only matters if we ever want a verified listing.

## 7. Compatibility on n8n upgrades

The user wants every n8n version bump checked against this node. Proposed CI on each `N8N_VERSION` change:
1. Build the node against the `n8n-workflow` version in the new image.
2. Boot the stack and confirm the node loads on main and workers with no startup errors.
3. Run a smoke workflow that resolves a dummy secret from a dedicated test vault with a test service account. Never use production tokens in CI. The repo already has `smoke/` and `scripts/smoke-test.sh` to extend.
4. Only then allow the upgrade to merge or deploy.
Consider Renovate or Dependabot on `N8N_VERSION` so each release opens a PR that runs these checks.

## 8. Suggested next steps

1. Check route D feasibility, then get the user's decision on delivery route A, B, C, or D (section 4).
2. Decide where the node's source lives (inside this repo, for example `nodes/n8n-nodes-<name>/`, or its own repo published to npm). With route A or B the package must reach a registry before the lock can reference it.
3. Prototype: confirm `@1password/sdk` loads inside `n8nio/n8n:2.45.7` under the bootstrap's `npm ci --ignore-scripts`. Use a test service account.
4. Scaffold the package (credential type, resolver node, wrapper node, cache).
5. Add the package to `community-packages/`, regenerate the lock, run `scripts/check-community-packages.py` and its tests.
6. Extend the smoke tests (section 7).
7. Ask before any push, deploy, or 1Password provisioning.

## 9. Repo conventions to follow in `~/Sites/n8n`

- Read `CLAUDE.md` and `AGENTS.md` first. The repo uses `lat.md/`: run `lat search` before work, update `lat.md/` after changes, and run `lat check`.
- `CONTINUITY.md` is the running log. Add entries for this work.
- After changes, dispatch the docs-sync subagent per `docs/agents/docs-sync.md` (from project memory).
- This repo is for infrastructure and operations. Workflow business logic belongs in `Ka-Chava/n8n-workflows`.

## 10. Build status (2026-11-09)

The user confirmed route A. This folder is now the package repo, scaffolded with `@n8n/node-cli` 0.55.6 (`programmatic/example` template).

What exists:
- Package `@kachava-team/n8n-nodes-1password` 0.1.0 (renamed on 2026-11-11 from `n8n-nodes-kachava-1password`, before any publish, so the npm org `kachava-team` owns it; `publishConfig.access` is `public` because scoped packages default to restricted). Author set to the user's work email. Repository URL assumed to be `github.com/Ka-Chava/n8n-nodes-kachava-1password` (repo not created yet). The user owns the naming and any 1Password trademark question.
- Credential `onePasswordServiceAccountApi` (one password field). Tested through `methods.credentialTest` (lists vaults), because the SDK is not plain HTTP.
- Node `onePasswordSecret` ("1Password Secret"): resolves an `op://` reference into an output field. Shows a notice that the value lands in execution history.
- Node `onePasswordHttpRequest` ("1Password HTTP Request"): header, query, basic or no auth; `op://` values in extra headers and query parameters; JSON body; redacts resolved secrets from output and errors; builds a fresh error object so request headers never reach execution data.
- `nodes/shared/secretCache.ts`: lazy SDK load, per-process client cache keyed by SHA-256 of the token, value cache with TTL (default 60 s) and a 500 entry cap, drops clients on failure or `AuthExpiredError`.
- Neither node sets `usableAsTool`. Whether n8n can still wrap community nodes as tools also depends on `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE`, which is unset in the n8n repo's compose and env examples (checked 2026-11-09). Keep it unset.
- The HTTP node's `execute` path is covered by `test/httpRequestNode.test.ts` (20 tests, added 2026-11-10): response splitting, empty and text bodies, "Include Status and Headers", JSON body rules, redaction of secrets and the token in output and errors, status code sources, the 2000 character description cap, Continue On Fail, and an empty token.
- Before the first commit: commit `package-lock.json` (CI runs `npm ci`). Pushing any tag matching `*.*.*` triggers `publish.yml` and publishes to npm.

Lint decisions (all documented in `eslint.config.mjs` or next to the code):
- Cloud support disabled (`configWithoutCloudSupport`, `"strict": false`): Cloud rules forbid importing `@1password/sdk` and `node:crypto`.
- `no-runtime-dependencies` off for `package.json`: the SDK's ~14 MB WASM core makes bundling fragile. The user should confirm this choice.
- Per-line suppressions: `op://` reference fields are not passwords; shared helpers rethrow because nodes wrap the errors; `usableAsTool` left out on purpose; the JSON body field is intentionally open-ended.
- Test fixtures are exempt from `no-hardcoded-secrets`.

Verified:
- `npm run build` and `npm run lint` pass (lint exit 0). `npm test` passes: 58 unit tests with the SDK mocked (2026-11-10).
- In `docker.n8n.io/n8nio/n8n:2.45.7` under OrbStack: `@1password/sdk` 0.5.0 installs with `npm ci --omit=dev --ignore-scripts` and loads (WASM fine). The packed tarball installs the same way; both nodes and the credential load; the credential test reaches the SDK and returns its "invalid service account token" error for a dummy token.
- n8n 2.45.7 started with the package via `N8N_CUSTOM_EXTENSIONS` registered `onePasswordSecret`, `onePasswordHttpRequest` and `onePasswordServiceAccountApi` with no load errors.

- Live check (2026-11-10, reported by the user): on n8n 2.45.7 in OrbStack (throwaway container on localhost, removed with its volume afterwards), the 1Password Secret node resolved a real secret from a dedicated test vault with a real service account token. A reference to an item in `[ADMIN] Engineering`, a vault the service account is not assigned to, failed as expected, which confirms vault scoping. The 1Password HTTP Request node (GET `https://httpbin.org/headers`, header auth, `Bearer ` prefix) sent the secret, and httpbin's echoed `Authorization` header came back as `Bearer [redacted by 1Password node]`, which confirms the `execute` path and output redaction. The credential "Test" button passed with the real token.
- `npm run dev` fails on 2026-11-10: `n8n-node dev` installs the latest n8n (2.47.2), and npm reports `No matching version found for @ai-sdk/provider-utils@5.0.79`. This is an upstream n8n packaging problem, not this package. Use the pinned image instead (packed tarball plus `N8N_CUSTOM_EXTENSIONS`).

Not verified yet:
- Install through the n8n repo's real pipeline (`community-packages/` lock, `graph.js` manifest, managed mode) on main and workers.

Packaging note: `n8n-workflow` is a peer dependency (`*`), as in n8n's template. npm installs it automatically, so `npm ci` in the nodes folder adds `n8n-workflow` and its tree (including `isolated-vm`). The n8n repo's lockfile already contains both through other packages, so this adds nothing new, but the node will load that copy of `n8n-workflow`, not n8n's own.

Repository (2026-11-10): `https://github.com/Ka-Chava/n8n-nodes-kachava-1password`, public (the user chose public, which npm provenance needs). `main` pushed over HTTPS with the `oliver-kachava` gh login (the local SSH key belongs to a personal account without Ka-Chava access). CI passed on `8c6029f`. No tags, nothing published to npm.

Security fixes after an automated review (commit `8c6029f`): the HTTP node sets `disableFollowRedirect`, because n8n only manages the `Authorization` header on a cross-origin redirect and a custom secret header would otherwise reach the new host. Redaction now also covers the base64 basic auth value and JSON-escaped secrets, and error bodies are redacted before serializing.

Release (2026-11-11): `@kachava-team/n8n-nodes-1password@0.1.0` published to npm by `publish.yml` (run 43061881876) from tag `0.1.0`, with an SLSA provenance attestation. Integrity `sha512-BbaikNFjuzpQWGBQdFllyqXSIuBjRzVn6gmxCJp+cVheQlD5UiYB2k87QLwAxkn1ayhfcU2DuWm3MlUk2iw/ig==`. The first publish used a short-lived `NPM_TOKEN` secret, because npm requires the package to exist before a trusted publisher can be configured. After that: configure trusted publishing (GitHub Actions, `Ka-Chava` / `n8n-nodes-kachava-1password` / `publish.yml`, allow `npm publish`), delete the `NPM_TOKEN` secret and revoke the token.

Next steps:
1. User: review the code; decide on the package name and the runtime dependency exception.
2. User: create a 1Password test vault and a test service account; run a live check (`npm run dev`, or the smoke tests).
3. Commit, push, set up npm trusted publishing, tag 0.1.0. Only with explicit approval.
4. In `~/Sites/n8n`: add the exact version to `community-packages/package.json`, regenerate the lock, run `scripts/check-community-packages.py` and its tests, and extend `smoke/` to resolve a dummy secret on every `N8N_VERSION` bump.

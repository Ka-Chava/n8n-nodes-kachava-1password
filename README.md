# n8n-nodes-kachava-1password

n8n community nodes that read secrets from 1Password with a vault-scoped service account. Built for Ka'Chava's self-hosted n8n (Community Edition), where n8n's own External Secrets feature is not available because it requires an Enterprise license.

A few admins keep the real credentials in 1Password. Each team gets a 1Password service account that can read only its own vault. Workflows reference secrets with `op://` secret references, and the master 1Password account is never shared.

This package is not affiliated with or endorsed by 1Password.

- [Nodes](#nodes)
- [Credentials](#credentials)
- [Security model](#security-model)
- [Installation](#installation)
- [Compatibility](#compatibility)
- [Development](#development)

## Nodes

### 1Password HTTP Request (recommended)

Calls an HTTP API and places a secret from 1Password into the request at run time. The secret never enters item data, so it is not saved in execution history.

- **Authentication:** header (name and prefix, for example `Authorization: Bearer <secret>`), query parameter, basic auth, or none.
- **Extra headers and query parameters:** any value that starts with `op://` is read from 1Password.
- **Body:** optional JSON body for POST, PUT, PATCH and DELETE.
- **Redirects are never followed**, so a redirect to another host cannot carry the secret with it. A 3xx response is reported as an error; use the final URL instead.
- **Output:** the response body. A JSON array becomes one item per element. Turn on "Include Status and Headers" to get `statusCode`, `headers` and `body`.
- **Redaction:** resolved secrets (and their URL-encoded and JSON-escaped forms, plus the encoded basic auth header) are replaced with `[redacted by 1Password node]` in the output and in error messages, in case an API echoes them back. Secrets shorter than 6 characters (such as a short PIN) are not redacted, to avoid mangling unrelated output.

### 1Password Secret

Resolves one secret reference and adds the value to the item under the field you choose (default `secret`).

Use it only when a later node cannot be replaced by the HTTP Request node above. **The value is written to the node output and saved in execution history.** Turn off saving execution data for workflows that use it.

### Both nodes

- **Cache Seconds** (default 60): resolved values stay in memory for this long to stay under 1Password rate limits. Use 0 to always fetch. Each n8n main and worker process has its own cache. Clients are cached per token, keyed by a SHA-256 hash of the token, never the raw token.
- Neither node sets `usableAsTool`, so n8n does not mark them as AI agent tools. Keep `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE` unset in the deployment (it is unset in `Ka-Chava/n8n` as of 2026-11-09), so community nodes are not wrapped as tools and secrets do not reach an LLM.

## Credentials

**1Password Service Account API**: one field, the service account token (`ops_...`).

1. In 1Password, create a service account with **read** access to the team's vault only.
2. Share the token with the team through 1Password.
3. Each n8n user creates the credential once with their team's token. "Test" lists the vaults the token can see.

To get a secret reference, open the item in 1Password, open the field's menu and choose **Copy Secret Reference**. The format is `op://<vault>/<item>/<field>` or `op://<vault>/<item>/<section>/<field>`.

## Security model

What this gives you:

- The 1Password master account is never shared.
- Access is limited to the vaults each service account can read.
- Credentials are rotated in one place, in 1Password.
- 1Password keeps an audit trail of which service account read what.

What it does not give you:

- **Workflow builders can still see secrets.** Anyone who can build a workflow that uses a secret can send it to their own server with a single HTTP Request node. This is also true of n8n Enterprise. Only give a team's token to people you trust with every secret in that team's vault.
- **Instance owners and admins can see all workflows and executions.**
- **The package runs inside the n8n process with full host access.** Pin exact versions and review every update.

Do not set one shared token as a host environment variable. Every user on the instance could then read every vault that token reaches.

## Installation

Ka'Chava installs this package through the locked community package list in the `Ka-Chava/n8n` repository (`community-packages/package.json` and its lockfile). Pin an exact version there.

On another self-hosted n8n, install it like any community node package. It has one runtime dependency, `@1password/sdk`, which has no install scripts, so it installs under `npm ci --ignore-scripts`.

n8n Cloud is not supported: n8n Cloud does not allow the SDK and `node:crypto` imports this package needs.

## Compatibility

- Tested against n8n `2.45.7` (Node.js 26, Alpine image) with `@1password/sdk` `0.5.0`.
- Every n8n version bump in `Ka-Chava/n8n` should run its smoke tests against the pinned version of this package.

## Development

```sh
npm install
npm run build     # compile to dist/
npm run lint      # n8n lint rules (cloud rules disabled, see eslint.config.mjs)
npm test          # unit tests, 1Password SDK mocked
npm run dev       # local n8n with hot reload on http://localhost:5678
```

Use OrbStack (not Docker Desktop) for any local container checks.

Lint exceptions are listed in `eslint.config.mjs` and next to the code they cover, each with its reason.

Releases go through `.github/workflows/publish.yml`, which publishes to npm with provenance when a version tag is pushed. Set up npm trusted publishing for the repository first.

# Changelog

## 0.1.0 (unreleased)

- 1Password Service Account API credential, tested by listing vaults.
- 1Password Secret node: resolves an `op://` secret reference into an output field.
- 1Password HTTP Request node: calls an API with a secret placed in a header, query parameter or basic auth, without putting the secret in item data. Redacts resolved secrets from output and errors.
- Per-process cache for SDK clients (keyed by token hash) and resolved values (default 60 seconds).

import { createHash } from 'node:crypto';

export const INTEGRATION_NAME = 'n8n-nodes-kachava-1password';
export const INTEGRATION_VERSION = 'v0.1.0';

/** Default number of seconds a resolved secret stays in memory. */
export const DEFAULT_CACHE_TTL_SECONDS = 60;

/** Upper bound on cached secret values per process. */
const MAX_CACHED_VALUES = 500;

/** Minimal surface of the 1Password SDK client that the nodes need. */
export interface SecretSource {
	resolve(reference: string): Promise<string>;
	/** Throws if the token is invalid or cannot reach 1Password. */
	verify(): Promise<void>;
}

export type SecretSourceFactory = (token: string) => Promise<SecretSource>;

/**
 * Builds a real 1Password SDK client. The SDK (and its WASM core) is loaded
 * lazily so that n8n startup does not pay for it until a node runs.
 */
export const createOnePasswordSource: SecretSourceFactory = async (token) => {
	const sdk = await import('@1password/sdk');
	const client = await sdk.createClient({
		auth: token,
		integrationName: INTEGRATION_NAME,
		integrationVersion: INTEGRATION_VERSION,
	});
	return {
		resolve: async (reference) => await client.secrets.resolve(reference),
		verify: async () => {
			await client.vaults.list();
		},
	};
};

/** Raised for problems the workflow author can fix, such as a malformed reference. */
export class SecretReferenceError extends Error {}

// op://vault/item/field or op://vault/item/section/field, optional ?query (for example ?attribute=totp).
// Names may contain spaces; the SDK does the authoritative validation.
const REFERENCE_PATTERN = /^op:\/\/[^/?]+\/[^/?]+(\/[^/?]+){1,2}(\?.*)?$/;

export function isSecretReference(value: string): boolean {
	return value.trim().startsWith('op://');
}

export function assertSecretReference(reference: string): void {
	if (!REFERENCE_PATTERN.test(reference.trim())) {
		throw new SecretReferenceError(
			`"${reference}" is not a valid secret reference. Use op://<vault>/<item>/<field> or op://<vault>/<item>/<section>/<field>.`,
		);
	}
}

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

function isAuthError(error: unknown): boolean {
	return error instanceof Error && error.constructor.name === 'AuthExpiredError';
}

/**
 * Per-process cache of SDK clients (keyed by a hash of the token, never the
 * raw token) and of resolved values with a short TTL. Each n8n main and worker
 * process has its own instance.
 */
export class SecretCache {
	private readonly sources = new Map<string, Promise<SecretSource>>();
	private readonly values = new Map<string, { value: string; expiresAt: number }>();

	constructor(
		private readonly factory: SecretSourceFactory,
		private readonly now: () => number = () => Date.now(),
		private readonly maxValues: number = MAX_CACHED_VALUES,
	) {}

	private getSource(token: string, tokenKey: string): Promise<SecretSource> {
		let source = this.sources.get(tokenKey);
		if (!source) {
			source = this.factory(token);
			this.sources.set(tokenKey, source);
			// A failed client must not stay cached, or a fixed token would keep failing.
			source.catch(() => this.dropToken(tokenKey));
		}
		return source;
	}

	private dropToken(tokenKey: string): void {
		this.sources.delete(tokenKey);
		for (const key of this.values.keys()) {
			if (key.startsWith(`${tokenKey}\u0000`)) this.values.delete(key);
		}
	}

	async resolve(token: string, reference: string, ttlSeconds: number): Promise<string> {
		const ref = reference.trim();
		assertSecretReference(ref);
		const tokenKey = hashToken(token);
		const valueKey = `${tokenKey}\u0000${ref}`;

		if (ttlSeconds > 0) {
			const hit = this.values.get(valueKey);
			if (hit && hit.expiresAt > this.now()) return hit.value;
			this.values.delete(valueKey);
		}

		let value: string;
		try {
			const source = await this.getSource(token, tokenKey);
			value = await source.resolve(ref);
		} catch (error) {
			if (isAuthError(error)) this.dropToken(tokenKey);
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- shared helper without node context; the nodes wrap this in NodeApiError
			throw error;
		}

		if (ttlSeconds > 0) {
			this.values.set(valueKey, { value, expiresAt: this.now() + ttlSeconds * 1000 });
			while (this.values.size > this.maxValues) {
				const oldest = this.values.keys().next().value;
				if (oldest === undefined) break;
				this.values.delete(oldest);
			}
		}
		return value;
	}

	async verify(token: string): Promise<void> {
		const tokenKey = hashToken(token);
		try {
			const source = await this.getSource(token, tokenKey);
			await source.verify();
		} catch (error) {
			this.dropToken(tokenKey);
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- shared helper without node context; the credential test turns this into a message
			throw error;
		}
	}

	/** Number of cached values. For tests. */
	get size(): number {
		return this.values.size;
	}
}

/** Shared cache used by all nodes in this process. */
export const secretCache = new SecretCache(createOnePasswordSource);

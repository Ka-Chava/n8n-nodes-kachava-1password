import { describe, expect, it, vi } from 'vitest';

import {
	assertSecretReference,
	SecretCache,
	SecretReferenceError,
	type SecretSource,
} from '../nodes/shared/secretCache';

class AuthExpiredError extends Error {}

function fakeFactory(values: Record<string, string>) {
	const resolve = vi.fn(async (ref: string) => {
		if (!(ref in values)) throw new Error(`no such secret ${ref}`);
		return values[ref];
	});
	const verify = vi.fn(async () => {});
	const factory = vi.fn(async (): Promise<SecretSource> => ({ resolve, verify }));
	return { factory, resolve, verify };
}

const REF = 'op://Team Vault/Shopify/credential';

describe('assertSecretReference', () => {
	it.each([
		'op://vault/item/field',
		'op://vault/item/section/field',
		'op://Team Vault/My Item/password',
		'op://vault/item/one-time password?attribute=totp',
	])('accepts %s', (ref) => {
		expect(() => assertSecretReference(ref)).not.toThrow();
	});

	it.each(['', 'vault/item/field', 'op://vault/item', 'op://vault/item/a/b/c', 'https://x/y/z'])(
		'rejects %s',
		(ref) => {
			expect(() => assertSecretReference(ref)).toThrow(SecretReferenceError);
		},
	);
});

describe('SecretCache', () => {
	it('serves repeat reads from cache within the TTL', async () => {
		let now = 0;
		const { factory, resolve } = fakeFactory({ [REF]: 'value-1' });
		const cache = new SecretCache(factory, () => now);

		expect(await cache.resolve('ops_token', REF, 60)).toBe('value-1');
		now = 59_000;
		expect(await cache.resolve('ops_token', REF, 60)).toBe('value-1');
		expect(resolve).toHaveBeenCalledTimes(1);

		now = 61_000;
		await cache.resolve('ops_token', REF, 60);
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it('always fetches when the TTL is 0', async () => {
		const { factory, resolve } = fakeFactory({ [REF]: 'value-1' });
		const cache = new SecretCache(factory);
		await cache.resolve('ops_token', REF, 0);
		await cache.resolve('ops_token', REF, 0);
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(cache.size).toBe(0);
	});

	it('keeps tokens apart and creates one client per token', async () => {
		const { factory, resolve } = fakeFactory({ [REF]: 'value-1' });
		const cache = new SecretCache(factory);
		await cache.resolve('ops_team_a', REF, 60);
		await cache.resolve('ops_team_b', REF, 60);
		await cache.resolve('ops_team_a', REF, 60);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it('trims the reference before caching', async () => {
		const { factory, resolve } = fakeFactory({ [REF]: 'value-1' });
		const cache = new SecretCache(factory);
		await cache.resolve('ops_token', `  ${REF} `, 60);
		await cache.resolve('ops_token', REF, 60);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('does not keep a client whose creation failed', async () => {
		const factory = vi
			.fn<(token: string) => Promise<SecretSource>>()
			.mockRejectedValueOnce(new Error('invalid service account token'))
			.mockResolvedValue({ resolve: async () => 'ok', verify: async () => {} });
		const cache = new SecretCache(factory);

		await expect(cache.resolve('ops_token', REF, 60)).rejects.toThrow('invalid service account token');
		await expect(cache.resolve('ops_token', REF, 60)).resolves.toBe('ok');
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it('drops the client and cached values after an auth error', async () => {
		let now = 0;
		const resolve = vi
			.fn<(ref: string) => Promise<string>>()
			.mockResolvedValueOnce('old')
			.mockRejectedValueOnce(new AuthExpiredError('expired'))
			.mockResolvedValue('new');
		const factory = vi.fn(async (): Promise<SecretSource> => ({ resolve, verify: async () => {} }));
		const cache = new SecretCache(factory, () => now);

		await cache.resolve('ops_token', REF, 1);
		now = 2_000;
		await expect(cache.resolve('ops_token', REF, 1)).rejects.toThrow('expired');
		expect(await cache.resolve('ops_token', REF, 1)).toBe('new');
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it('evicts the oldest values beyond the size limit', async () => {
		const refs = ['op://v/a/f', 'op://v/b/f', 'op://v/c/f'];
		const { factory } = fakeFactory(Object.fromEntries(refs.map((r) => [r, r])));
		const cache = new SecretCache(factory, () => 0, 2);
		for (const ref of refs) await cache.resolve('ops_token', ref, 60);
		expect(cache.size).toBe(2);
	});

	it('rejects malformed references without calling 1Password', async () => {
		const { factory } = fakeFactory({});
		const cache = new SecretCache(factory);
		await expect(cache.resolve('ops_token', 'vault/item', 60)).rejects.toThrow(SecretReferenceError);
		expect(factory).not.toHaveBeenCalled();
	});

	it('verify drops a client that fails', async () => {
		const verify = vi.fn().mockRejectedValueOnce(new Error('bad token')).mockResolvedValue(undefined);
		const factory = vi.fn(async (): Promise<SecretSource> => ({ resolve: async () => 'x', verify }));
		const cache = new SecretCache(factory);
		await expect(cache.verify('ops_token')).rejects.toThrow('bad token');
		await expect(cache.verify('ops_token')).resolves.toBeUndefined();
		expect(factory).toHaveBeenCalledTimes(2);
	});
});

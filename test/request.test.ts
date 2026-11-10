import { describe, expect, it, vi } from 'vitest';

import { buildRequest, RequestSpecError, type RequestSpec } from '../nodes/OnePasswordHttpRequest/request';

const secrets: Record<string, string> = {
	'op://v/api/credential': 'api-key-111111',
	'op://v/basic/username': 'svc-user-222222',
	'op://v/basic/password': 'basic-pass-333333',
	'op://v/extra/header': 'extra-header-444444',
};
const resolver = vi.fn(async (ref: string) => secrets[ref]);

function spec(overrides: Partial<RequestSpec>): RequestSpec {
	return {
		method: 'GET',
		url: 'https://api.example.com/v1/things',
		authPlacement: 'header',
		secretReference: 'op://v/api/credential',
		headerName: 'Authorization',
		valuePrefix: 'Bearer ',
		queryParameterName: 'api_key',
		basicUsername: '',
		basicPasswordReference: '',
		headers: [],
		query: [],
		timeout: 30000,
		...overrides,
	};
}

describe('buildRequest', () => {
	it('puts the secret in a header with the prefix', async () => {
		const { options, secrets: used } = await buildRequest(spec({}), resolver);
		expect(options.headers).toEqual({ Authorization: 'Bearer api-key-111111' });
		expect(options.returnFullResponse).toBe(true);
		expect(options.disableFollowRedirect).toBe(true);
		expect(used).toEqual(['api-key-111111']);
	});

	it('lets the auth header win over an extra header with the same name', async () => {
		const { options } = await buildRequest(
			spec({ headers: [{ name: 'Authorization', value: 'spoofed' }] }),
			resolver,
		);
		expect(options.headers).toEqual({ Authorization: 'Bearer api-key-111111' });
	});

	it('puts the secret in a query parameter', async () => {
		const { options } = await buildRequest(spec({ authPlacement: 'query' }), resolver);
		expect(options.qs).toEqual({ api_key: 'api-key-111111' });
		expect(options.headers).toEqual({});
	});

	it('supports basic auth with a username reference', async () => {
		const { options, secrets: used } = await buildRequest(
			spec({
				authPlacement: 'basic',
				basicUsername: 'op://v/basic/username',
				basicPasswordReference: 'op://v/basic/password',
			}),
			resolver,
		);
		expect(options.auth).toEqual({ username: 'svc-user-222222', password: 'basic-pass-333333' });
		expect(used).toEqual([
			'svc-user-222222',
			'basic-pass-333333',
			Buffer.from('svc-user-222222:basic-pass-333333').toString('base64'),
		]);
	});

	it('keeps a plain basic auth username as is', async () => {
		const { options } = await buildRequest(
			spec({ authPlacement: 'basic', basicUsername: 'plain', basicPasswordReference: 'op://v/basic/password' }),
			resolver,
		);
		expect(options.auth?.username).toBe('plain');
	});

	it('resolves op:// values in extra headers and query parameters only', async () => {
		const { options, secrets: used } = await buildRequest(
			spec({
				authPlacement: 'none',
				headers: [
					{ name: 'X-Key', value: 'op://v/extra/header' },
					{ name: 'X-Plain', value: 'hello' },
					{ name: ' ', value: 'ignored' },
				],
				query: [{ name: 'page', value: '2' }],
			}),
			resolver,
		);
		expect(options.headers).toEqual({ 'X-Key': 'extra-header-444444', 'X-Plain': 'hello' });
		expect(options.qs).toEqual({ page: '2' });
		expect(used).toEqual(['extra-header-444444']);
	});

	it('passes the body through', async () => {
		const { options } = await buildRequest(spec({ method: 'POST', body: { a: 1 } }), resolver);
		expect(options.body).toEqual({ a: 1 });
	});

	it.each(['ftp://x', 'api.example.com', ''])('rejects the URL %s', async (url) => {
		await expect(buildRequest(spec({ url }), resolver)).rejects.toThrow(RequestSpecError);
	});

	it('rejects an empty header name', async () => {
		await expect(buildRequest(spec({ headerName: ' ' }), resolver)).rejects.toThrow(RequestSpecError);
	});
});

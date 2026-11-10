import type { IDataObject, IExecuteFunctions, INode, IPairedItemData } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OnePasswordHttpRequest } from '../nodes/OnePasswordHttpRequest/OnePasswordHttpRequest.node';
import { REDACTED } from '../nodes/shared/redact';
import { assertSecretReference, secretCache } from '../nodes/shared/secretCache';

vi.mock('../nodes/shared/secretCache', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../nodes/shared/secretCache')>();
	return { ...actual, secretCache: { resolve: vi.fn(), verify: vi.fn() } };
});

const TOKEN = 'ops_fake-token-for-tests-000000';
const SECRET = 'api-key-111111';
const EXTRA = 'extra-header-444444';
const SECRETS: Record<string, string> = {
	'op://v/api/credential': SECRET,
	'op://v/extra/header': EXTRA,
};

const resolveMock = vi.mocked(secretCache.resolve);

const node: INode = {
	id: 'node-1',
	name: '1Password HTTP Request',
	type: 'onePasswordHttpRequest',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

type Params = IDataObject;

function baseParams(overrides: Params = {}): Params {
	return {
		method: 'GET',
		url: 'https://api.example.com/v1/things',
		authPlacement: 'header',
		secretReference: 'op://v/api/credential',
		headerName: 'Authorization',
		valuePrefix: 'Bearer ',
		options: {},
		...overrides,
	};
}

function lookup(params: Params, name: string): unknown {
	return name.split('.').reduce<unknown>((value, key) => {
		if (value !== null && typeof value === 'object') return (value as IDataObject)[key];
		return undefined;
	}, params);
}

interface ContextSetup {
	params: Params | Params[];
	httpRequest: (options: IDataObject) => Promise<unknown>;
	continueOnFail?: boolean;
	token?: string;
}

function context(setup: ContextSetup) {
	const perItem = Array.isArray(setup.params) ? setup.params : [setup.params];
	const httpRequest = vi.fn(setup.httpRequest);
	const ctx = {
		getInputData: () => perItem.map((_, i) => ({ json: { index: i } })),
		getNodeParameter: (name: string, i: number, fallback?: unknown) => {
			const value = lookup(perItem[i], name);
			return value === undefined ? fallback : value;
		},
		getCredentials: async () => ({ serviceAccountToken: setup.token ?? TOKEN }),
		getNode: () => node,
		continueOnFail: () => setup.continueOnFail ?? false,
		helpers: { httpRequest },
	};
	return { ctx: ctx as unknown as IExecuteFunctions, httpRequest };
}

function ok(body: unknown, extra: IDataObject = {}) {
	return async () => ({ body, statusCode: 200, headers: { 'content-type': 'application/json' }, ...extra });
}

async function run(setup: ContextSetup) {
	const { ctx, httpRequest } = context(setup);
	const result = await new OnePasswordHttpRequest().execute.call(ctx);
	return { items: result[0], httpRequest };
}

async function runError(setup: ContextSetup): Promise<unknown> {
	const { ctx } = context(setup);
	try {
		await new OnePasswordHttpRequest().execute.call(ctx);
	} catch (error) {
		return error;
	}
	throw new Error('expected execute to throw');
}

beforeEach(() => {
	resolveMock.mockReset();
	resolveMock.mockImplementation(async (_token, reference) => {
		// Mirror the real cache, which validates the reference before calling 1Password.
		assertSecretReference(reference);
		const value = SECRETS[reference];
		if (value === undefined) throw new Error(`no such item: ${reference}`);
		return value;
	});
});

describe('OnePasswordHttpRequest execute: responses', () => {
	it('returns an object body as one item paired to its input', async () => {
		const { items, httpRequest } = await run({ params: baseParams(), httpRequest: ok({ id: 1 }) });
		expect(items).toEqual([{ json: { id: 1 }, pairedItem: { item: 0 } }]);
		const sent = httpRequest.mock.calls[0][0] as IDataObject;
		expect(sent.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
		expect(sent.url).toBe('https://api.example.com/v1/things');
	});

	it('resolves with the credential token and the default cache TTL', async () => {
		await run({ params: baseParams(), httpRequest: ok({}) });
		expect(resolveMock).toHaveBeenCalledWith(TOKEN, 'op://v/api/credential', 60);
	});

	it('passes a custom cache TTL', async () => {
		await run({ params: baseParams({ options: { cacheTtl: 0 } }), httpRequest: ok({}) });
		expect(resolveMock).toHaveBeenCalledWith(TOKEN, 'op://v/api/credential', 0);
	});

	it('splits a JSON array into one item per element and wraps primitives', async () => {
		const { items } = await run({
			params: baseParams(),
			httpRequest: ok([{ a: 1 }, 'text', 3, null, [1, 2]]),
		});
		expect(items.map((item) => item.json)).toEqual([
			{ a: 1 },
			{ data: 'text' },
			{ data: 3 },
			{ data: null },
			{ data: [1, 2] },
		]);
		expect(items.every((item) => (item.pairedItem as IPairedItemData).item === 0)).toBe(true);
	});

	it('returns an empty item for an empty body and wraps a text body', async () => {
		const empty = await run({ params: baseParams(), httpRequest: ok('') });
		expect(empty.items).toEqual([{ json: {}, pairedItem: { item: 0 } }]);
		const missing = await run({ params: baseParams(), httpRequest: ok(undefined) });
		expect(missing.items).toEqual([{ json: {}, pairedItem: { item: 0 } }]);
		const text = await run({ params: baseParams(), httpRequest: ok('hello') });
		expect(text.items).toEqual([{ json: { data: 'hello' }, pairedItem: { item: 0 } }]);
	});

	it('redacts resolved secrets and the token echoed in the body', async () => {
		const { items } = await run({
			params: baseParams({
				headers: { values: [{ name: 'X-Extra', value: 'op://v/extra/header' }] },
			}),
			httpRequest: ok({
				headers: { Authorization: `Bearer ${SECRET}`, 'X-Extra': EXTRA },
				echoedToken: TOKEN,
				[SECRET]: 'secret as a key',
			}),
		});
		const output = JSON.stringify(items);
		expect(output).not.toContain(SECRET);
		expect(output).not.toContain(EXTRA);
		expect(output).not.toContain(TOKEN);
		expect(items[0].json).toMatchObject({
			headers: { Authorization: `Bearer ${REDACTED}`, 'X-Extra': REDACTED },
			echoedToken: REDACTED,
		});
	});

	it('includes status and redacted headers when Include Status and Headers is on', async () => {
		const { items } = await run({
			params: baseParams({ options: { includeResponseMeta: true } }),
			httpRequest: ok({ ok: true }, { statusCode: 201, headers: { 'x-echo': SECRET } }),
		});
		expect(items).toEqual([
			{
				json: { statusCode: 201, headers: { 'x-echo': REDACTED }, body: { ok: true } },
				pairedItem: { item: 0 },
			},
		]);
	});

	it('keeps one item per input item, each paired to its input', async () => {
		const { items } = await run({
			params: [baseParams(), baseParams({ url: 'https://api.example.com/v1/other' })],
			httpRequest: ok({ ok: true }),
		});
		expect(items.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
	});
});

describe('OnePasswordHttpRequest execute: body', () => {
	it('sends a parsed JSON body for POST when Send Body is on', async () => {
		const { httpRequest } = await run({
			params: baseParams({ method: 'POST', sendBody: true, jsonBody: '{"name":"x"}' }),
			httpRequest: ok({}),
		});
		expect((httpRequest.mock.calls[0][0] as IDataObject).body).toEqual({ name: 'x' });
	});

	it('does not send a body for GET even when Send Body is set', async () => {
		const { httpRequest } = await run({
			params: baseParams({ method: 'GET', sendBody: true, jsonBody: '{"name":"x"}' }),
			httpRequest: ok({}),
		});
		expect((httpRequest.mock.calls[0][0] as IDataObject).body).toBeUndefined();
	});

	it('rejects invalid JSON with a node error and makes no request', async () => {
		const httpRequest = vi.fn(ok({}));
		const error = await runError({
			params: baseParams({ method: 'POST', sendBody: true, jsonBody: '{not json' }),
			httpRequest,
		});
		expect(error).toBeInstanceOf(NodeOperationError);
		expect((error as Error).message).toBe('JSON Body is not valid JSON.');
		expect(httpRequest).not.toHaveBeenCalled();
	});
});

describe('OnePasswordHttpRequest execute: errors', () => {
	function httpFailure(response: IDataObject, message = 'Request failed') {
		return async () => {
			const error = new Error(message) as Error & IDataObject;
			error.response = response;
			error.config = { headers: { Authorization: `Bearer ${SECRET}` } };
			throw error;
		};
	}

	it('throws a NodeApiError with the status code and a redacted body', async () => {
		const error = await runError({
			params: baseParams(),
			httpRequest: httpFailure(
				{ status: 401, data: { error: 'bad key', key: SECRET } },
				`Request failed with key ${SECRET}`,
			),
		});
		expect(error).toBeInstanceOf(NodeApiError);
		const apiError = error as NodeApiError;
		expect(apiError.httpCode).toBe('401');
		expect(apiError.message).toBe(`Request failed with key ${REDACTED}`);
		expect(apiError.description).toContain(REDACTED);
		expect(apiError.description).not.toContain(SECRET);
	});

	it('never attaches the original request or its headers to the error', async () => {
		const error = (await runError({
			params: baseParams(),
			httpRequest: httpFailure({ status: 500, data: 'oops' }),
		})) as NodeApiError;
		const serialized = JSON.stringify({
			message: error.message,
			description: error.description,
			errorResponse: (error as unknown as IDataObject).errorResponse,
			cause: (error as unknown as IDataObject).cause,
			context: error.context,
		});
		expect(serialized).not.toContain(SECRET);
		expect(serialized).not.toContain(TOKEN);
	});

	it('reads the status from response.statusCode or httpCode', async () => {
		const fromStatusCode = (await runError({
			params: baseParams(),
			httpRequest: httpFailure({ statusCode: 404, body: 'missing' }),
		})) as NodeApiError;
		expect(fromStatusCode.httpCode).toBe('404');
		expect(fromStatusCode.description).toBe('missing');

		const fromHttpCode = (await runError({
			params: baseParams(),
			httpRequest: async () => {
				throw Object.assign(new Error('Gateway timeout'), { httpCode: '504' });
			},
		})) as NodeApiError;
		expect(fromHttpCode.httpCode).toBe('504');
	});

	it('caps the error description at 2000 characters', async () => {
		const error = (await runError({
			params: baseParams(),
			httpRequest: httpFailure({ status: 400, data: 'x'.repeat(5000) }),
		})) as NodeApiError;
		expect(error.description).toHaveLength(2000);
	});

	it('turns a bad secret reference into a node error without calling the API', async () => {
		const httpRequest = vi.fn(ok({}));
		const error = await runError({
			params: baseParams({ secretReference: 'not-a-reference' }),
			httpRequest,
		});
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('turns a non-http URL into a node error', async () => {
		const error = await runError({
			params: baseParams({ url: 'ftp://files.example.com/x' }),
			httpRequest: ok({}),
		});
		expect(error).toBeInstanceOf(NodeOperationError);
	});

	it('redacts the token from a 1Password failure message', async () => {
		resolveMock.mockRejectedValueOnce(new Error(`token ${TOKEN} has no access`));
		const error = (await runError({ params: baseParams(), httpRequest: ok({}) })) as Error;
		expect(error.message).not.toContain(TOKEN);
		expect(error.message).toContain(REDACTED);
	});

	it('returns a redacted error item and continues when Continue On Fail is on', async () => {
		let call = 0;
		const { items } = await run({
			params: [baseParams(), baseParams()],
			continueOnFail: true,
			httpRequest: async () => {
				call++;
				if (call === 1) throw new Error(`boom ${SECRET}`);
				return { body: { ok: true }, statusCode: 200, headers: {} };
			},
		});
		expect(items).toEqual([
			{ json: { error: `boom ${REDACTED}` }, pairedItem: { item: 0 } },
			{ json: { ok: true }, pairedItem: { item: 1 } },
		]);
	});

	it('rejects an empty token before any request', async () => {
		const httpRequest = vi.fn(ok({}));
		const error = await runError({ params: baseParams(), httpRequest, token: '   ' });
		expect(error).toBeInstanceOf(NodeOperationError);
		expect(httpRequest).not.toHaveBeenCalled();
		expect(resolveMock).not.toHaveBeenCalled();
	});
});

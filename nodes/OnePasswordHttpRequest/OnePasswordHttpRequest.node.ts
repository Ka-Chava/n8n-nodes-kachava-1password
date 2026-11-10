import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	CREDENTIAL_TEST_METHOD,
	getServiceAccountToken,
	safeMessage,
	testServiceAccount,
} from '../shared/credentials';
import { redactString, redactValue } from '../shared/redact';
import { DEFAULT_CACHE_TTL_SECONDS, SecretReferenceError, secretCache } from '../shared/secretCache';
import type { AuthPlacement, NameValue, RequestSpec } from './request';
import { buildRequest, RequestSpecError } from './request';

interface HttpOptions {
	cacheTtl?: number;
	timeout?: number;
	includeResponseMeta?: boolean;
}

interface FullResponse {
	statusCode?: number;
	headers?: IDataObject;
	body?: unknown;
}

interface HttpErrorLike {
	message?: string;
	httpCode?: string | number;
	response?: { status?: number; statusCode?: number; data?: unknown; body?: unknown };
}

const BODY_METHODS: IHttpRequestMethods[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

function toItems(body: unknown): IDataObject[] {
	if (Array.isArray(body)) {
		return body.map((entry) =>
			entry !== null && typeof entry === 'object' && !Array.isArray(entry)
				? (entry as IDataObject)
				: ({ data: entry } as IDataObject),
		);
	}
	if (body !== null && typeof body === 'object') return [body as IDataObject];
	if (body === undefined || body === '') return [{}];
	return [{ data: body } as IDataObject];
}

/**
 * Programmatic style: the secret has to be fetched from the 1Password SDK and
 * placed into the request at run time, which a declarative node cannot do.
 */
// usableAsTool is left out on purpose so n8n never offers this node to AI agents: secrets must not reach an LLM.
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class OnePasswordHttpRequest implements INodeType {
	description: INodeTypeDescription = {
		displayName: '1Password HTTP Request',
		name: 'onePasswordHttpRequest',
		icon: { light: 'file:key.svg', dark: 'file:key.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["method"] + ": " + $parameter["url"]}}',
		description:
			'Call an HTTP API with a secret from 1Password. The secret never appears in item data.',
		defaults: {
			name: '1Password HTTP Request',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'onePasswordServiceAccountApi',
				required: true,
				testedBy: 'onePasswordServiceAccountApiTest',
			},
		],
		properties: [
			{
				displayName: 'Method',
				name: 'method',
				type: 'options',
				options: [
					{ name: 'DELETE', value: 'DELETE' },
					{ name: 'GET', value: 'GET' },
					{ name: 'HEAD', value: 'HEAD' },
					{ name: 'PATCH', value: 'PATCH' },
					{ name: 'POST', value: 'POST' },
					{ name: 'PUT', value: 'PUT' },
				],
				default: 'GET',
				description: 'The HTTP method to use',
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://api.example.com/v1/resource',
				description: 'The URL to call',
			},
			{
				displayName: 'Authentication',
				name: 'authPlacement',
				type: 'options',
				options: [
					{
						name: 'Header',
						value: 'header',
						description: 'Send the secret in a request header',
					},
					{
						name: 'Query Parameter',
						value: 'query',
						description: 'Send the secret as a URL query parameter',
					},
					{
						name: 'Basic Auth',
						value: 'basic',
						description: 'Send a username and a secret password with HTTP basic auth',
					},
					{
						name: 'None',
						value: 'none',
						description: 'Only use secret references in the extra headers or query parameters',
					},
				],
				default: 'header',
			},
			{
				displayName: 'Secret Reference',
				name: 'secretReference',
				// eslint-disable-next-line n8n-nodes-base/node-param-type-options-password-missing -- holds an op:// reference, not the secret itself
				type: 'string',
				required: true,
				default: '',
				placeholder: 'op://vault/item/credential',
				description: 'Secret reference of the API key or token to send',
				displayOptions: { show: { authPlacement: ['header', 'query'] } },
			},
			{
				displayName: 'Header Name',
				name: 'headerName',
				type: 'string',
				default: 'Authorization',
				displayOptions: { show: { authPlacement: ['header'] } },
			},
			{
				displayName: 'Value Prefix',
				name: 'valuePrefix',
				type: 'string',
				default: 'Bearer ',
				description:
					'Text placed before the secret in the header, including any trailing space. Leave empty to send the secret alone.',
				displayOptions: { show: { authPlacement: ['header'] } },
			},
			{
				displayName: 'Query Parameter Name',
				name: 'queryParameterName',
				type: 'string',
				default: 'api_key',
				displayOptions: { show: { authPlacement: ['query'] } },
			},
			{
				displayName: 'Username',
				name: 'basicUsername',
				type: 'string',
				default: '',
				description: 'Plain text, or a secret reference (op://...) to read it from 1Password',
				displayOptions: { show: { authPlacement: ['basic'] } },
			},
			{
				displayName: 'Password Secret Reference',
				name: 'basicPasswordReference',
				// eslint-disable-next-line n8n-nodes-base/node-param-type-options-password-missing -- holds an op:// reference, not the secret itself
				type: 'string',
				required: true,
				default: '',
				placeholder: 'op://vault/item/password',
				displayOptions: { show: { authPlacement: ['basic'] } },
			},
			{
				displayName: 'Headers',
				name: 'headers',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Header',
				default: {},
				description: 'Extra headers. Values that start with op:// are read from 1Password.',
				options: [
					{
						name: 'values',
						displayName: 'Header',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Query Parameters',
				name: 'queryParameters',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Parameter',
				default: {},
				description: 'Extra query parameters. Values that start with op:// are read from 1Password.',
				options: [
					{
						name: 'values',
						displayName: 'Parameter',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Send Body',
				name: 'sendBody',
				type: 'boolean',
				default: false,
				displayOptions: { show: { method: BODY_METHODS } },
			},
			// eslint-disable-next-line @n8n/community-nodes/open-ended-node-fields -- a generic HTTP wrapper has to accept any request body
			{
				displayName: 'JSON Body',
				name: 'jsonBody',
				type: 'json',
				default: '{}',
				displayOptions: { show: { method: BODY_METHODS, sendBody: [true] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Cache Seconds',
						name: 'cacheTtl',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: DEFAULT_CACHE_TTL_SECONDS,
						description:
							'How long to keep secrets in memory to avoid 1Password rate limits. Use 0 to always fetch.',
					},
					{
						displayName: 'Include Status and Headers',
						name: 'includeResponseMeta',
						type: 'boolean',
						default: false,
						description:
							'Whether to return the status code and response headers along with the body',
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 30000,
						description: 'Time to wait for the server to respond, in milliseconds',
					},
				],
			},
		],
	};

	methods = {
		credentialTest: {
			[CREDENTIAL_TEST_METHOD]: testServiceAccount,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const token = await getServiceAccountToken.call(this);

		for (let i = 0; i < items.length; i++) {
			let secrets: string[] = [token];
			try {
				const options = this.getNodeParameter('options', i, {}) as HttpOptions;
				const cacheTtl = options.cacheTtl ?? DEFAULT_CACHE_TTL_SECONDS;
				const method = this.getNodeParameter('method', i) as IHttpRequestMethods;
				const authPlacement = this.getNodeParameter('authPlacement', i) as AuthPlacement;
				const usesSecretReference = authPlacement === 'header' || authPlacement === 'query';

				let body: IDataObject | IDataObject[] | undefined;
				if (BODY_METHODS.includes(method) && (this.getNodeParameter('sendBody', i, false) as boolean)) {
					const raw = this.getNodeParameter('jsonBody', i, '{}') as string | IDataObject;
					try {
						body = typeof raw === 'string' ? (JSON.parse(raw) as IDataObject) : raw;
					} catch {
						throw new NodeOperationError(this.getNode(), 'JSON Body is not valid JSON.', {
							itemIndex: i,
						});
					}
				}

				const spec: RequestSpec = {
					method,
					url: this.getNodeParameter('url', i) as string,
					authPlacement,
					secretReference: usesSecretReference
						? (this.getNodeParameter('secretReference', i) as string)
						: '',
					headerName:
						authPlacement === 'header' ? (this.getNodeParameter('headerName', i) as string) : '',
					valuePrefix:
						authPlacement === 'header' ? (this.getNodeParameter('valuePrefix', i, '') as string) : '',
					queryParameterName:
						authPlacement === 'query'
							? (this.getNodeParameter('queryParameterName', i) as string)
							: '',
					basicUsername:
						authPlacement === 'basic' ? (this.getNodeParameter('basicUsername', i, '') as string) : '',
					basicPasswordReference:
						authPlacement === 'basic'
							? (this.getNodeParameter('basicPasswordReference', i) as string)
							: '',
					headers: (this.getNodeParameter('headers.values', i, []) as NameValue[]) ?? [],
					query: (this.getNodeParameter('queryParameters.values', i, []) as NameValue[]) ?? [],
					body,
					timeout: options.timeout ?? 30000,
				};

				const built = await buildRequest(spec, async (reference) =>
					await secretCache.resolve(token, reference, cacheTtl),
				);
				secrets = [token, ...built.secrets];

				const response = (await this.helpers.httpRequest(built.options)) as FullResponse;
				const safeBody = redactValue(response.body, secrets);

				if (options.includeResponseMeta) {
					returnData.push({
						json: redactValue(
							{
								statusCode: response.statusCode,
								headers: response.headers ?? {},
								body: safeBody,
							} as IDataObject,
							secrets,
						),
						pairedItem: { item: i },
					});
				} else {
					for (const json of toItems(safeBody)) {
						returnData.push({ json, pairedItem: { item: i } });
					}
				}
			} catch (error) {
				const message = safeMessage(error, secrets);
				if (this.continueOnFail()) {
					returnData.push({ json: { error: message }, pairedItem: { item: i } });
					continue;
				}
				if (
					error instanceof NodeOperationError ||
					error instanceof SecretReferenceError ||
					error instanceof RequestSpecError
				) {
					throw new NodeOperationError(this.getNode(), message, { itemIndex: i });
				}
				// Build a fresh, redacted error so the request (with its secret
				// headers) is never attached to the execution data.
				const httpError = error as HttpErrorLike;
				const status =
					httpError.response?.status ?? httpError.response?.statusCode ?? httpError.httpCode;
				const responseBody = httpError.response?.data ?? httpError.response?.body;
				const description =
					responseBody === undefined
						? undefined
						: (typeof responseBody === 'string'
								? redactString(responseBody, secrets)
								: redactString(JSON.stringify(redactValue(responseBody, secrets)), secrets)
							).slice(0, 2000);
				const errorObject: JsonObject = { message };
				if (status !== undefined) errorObject.httpCode = String(status);
				throw new NodeApiError(this.getNode(), errorObject, {
					itemIndex: i,
					message,
					description,
					httpCode: status !== undefined ? String(status) : undefined,
				});
			}
		}

		return [returnData];
	}
}

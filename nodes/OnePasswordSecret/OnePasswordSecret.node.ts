import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	CREDENTIAL_TEST_METHOD,
	getServiceAccountToken,
	safeMessage,
	testServiceAccount,
} from '../shared/credentials';
import { DEFAULT_CACHE_TTL_SECONDS, SecretReferenceError, secretCache } from '../shared/secretCache';

/**
 * Programmatic style: secrets come from the 1Password SDK (a WASM client), not
 * from HTTP calls that a declarative node could describe.
 */
// usableAsTool is left out on purpose so n8n never offers this node to AI agents: secrets must not reach an LLM.
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class OnePasswordSecret implements INodeType {
	description: INodeTypeDescription = {
		displayName: '1Password Secret',
		name: 'onePasswordSecret',
		icon: { light: 'file:key.svg', dark: 'file:key.dark.svg' },
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Read a secret from 1Password with a service account',
		defaults: {
			name: '1Password Secret',
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
				displayName:
					'The secret is written to this node\'s output and saved in the execution history. Prefer the "1Password HTTP Request" node, or turn off saving execution data for this workflow.',
				name: 'outputNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Secret', value: 'secret' }],
				default: 'secret',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['secret'] } },
				options: [
					{
						name: 'Resolve',
						value: 'resolve',
						description: 'Read one secret by its secret reference',
						action: 'Resolve a secret',
					},
				],
				default: 'resolve',
			},
			{
				displayName: 'Secret Reference',
				name: 'secretReference',
				// eslint-disable-next-line n8n-nodes-base/node-param-type-options-password-missing -- holds an op:// reference, not the secret itself
				type: 'string',
				required: true,
				default: '',
				placeholder: 'op://vault/item/field',
				description:
					'Secret reference to read. In 1Password, open the item, select the field\'s menu and choose "Copy Secret Reference".',
				displayOptions: { show: { resource: ['secret'], operation: ['resolve'] } },
			},
			{
				displayName: 'Output Field',
				name: 'outputField',
				type: 'string',
				required: true,
				default: 'secret',
				description: 'Name of the field that receives the secret value',
				displayOptions: { show: { resource: ['secret'], operation: ['resolve'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['secret'], operation: ['resolve'] } },
				options: [
					{
						displayName: 'Cache Seconds',
						name: 'cacheTtl',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: DEFAULT_CACHE_TTL_SECONDS,
						description:
							'How long to keep the secret in memory to avoid 1Password rate limits. Use 0 to always fetch.',
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
			try {
				const reference = this.getNodeParameter('secretReference', i) as string;
				const outputField = (this.getNodeParameter('outputField', i) as string).trim();
				const options = this.getNodeParameter('options', i, {}) as { cacheTtl?: number };
				if (!outputField) {
					throw new NodeOperationError(this.getNode(), 'Output Field cannot be empty.', {
						itemIndex: i,
					});
				}

				const value = await secretCache.resolve(
					token,
					reference,
					options.cacheTtl ?? DEFAULT_CACHE_TTL_SECONDS,
				);

				returnData.push({
					json: { ...items[i].json, [outputField]: value },
					pairedItem: { item: i },
				});
			} catch (error) {
				const message = safeMessage(error, [token]);
				if (this.continueOnFail()) {
					returnData.push({ json: { error: message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof NodeOperationError || error instanceof SecretReferenceError) {
					throw new NodeOperationError(this.getNode(), message, { itemIndex: i });
				}
				throw new NodeApiError(this.getNode(), { message }, { itemIndex: i, message });
			}
		}

		return [returnData];
	}
}

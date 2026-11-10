import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

/**
 * A 1Password service account token. The token decides which vaults the
 * workflow can read, so give each team its own service account with read
 * access to that team's vault only.
 *
 * There is no HTTP `test` block because the SDK does not use HTTP requests
 * that n8n can describe. The nodes test the credential through
 * `methods.credentialTest` instead (see `testedBy` in the nodes).
 */
export class OnePasswordServiceAccountApi implements ICredentialType {
	name = 'onePasswordServiceAccountApi';

	displayName = '1Password Service Account API';

	icon: Icon = { light: 'file:key.svg', dark: 'file:key.dark.svg' };

	documentationUrl =
		'https://github.com/Ka-Chava/n8n-nodes-kachava-1password?tab=readme-ov-file#credentials';

	properties: INodeProperties[] = [
		{
			displayName:
				'Use a service account that can read only the vaults this team needs. Anyone who can use this credential in a workflow can read every secret in those vaults.',
			name: 'scopeNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Service Account Token',
			name: 'serviceAccountToken',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'ops_...',
			description: 'Token of a 1Password service account. Starts with "ops_".',
		},
	];
}

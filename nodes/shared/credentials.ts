import type {
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IExecuteFunctions,
	INodeCredentialTestResult,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { redactString } from './redact';
import { secretCache } from './secretCache';

// Node descriptions repeat these as literals because n8n's lint rules read them statically.
export const CREDENTIAL_NAME = 'onePasswordServiceAccountApi';
export const CREDENTIAL_TEST_METHOD = 'onePasswordServiceAccountApiTest';

/** Error message safe to show in the UI or store in execution data. */
export function safeMessage(error: unknown, secrets: string[]): string {
	const message = error instanceof Error ? error.message : String(error);
	return redactString(message, secrets);
}

export async function getServiceAccountToken(this: IExecuteFunctions): Promise<string> {
	const credentials = await this.getCredentials(CREDENTIAL_NAME);
	const token = credentials.serviceAccountToken;
	if (typeof token !== 'string' || token.trim() === '') {
		throw new NodeOperationError(this.getNode(), 'The 1Password service account token is empty.');
	}
	return token.trim();
}

export async function testServiceAccount(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
	const token = credential.data?.serviceAccountToken;
	if (typeof token !== 'string' || token.trim() === '') {
		return { status: 'Error', message: 'The service account token is empty.' };
	}
	try {
		await secretCache.verify(token.trim());
		return { status: 'OK', message: 'Connected to 1Password' };
	} catch (error) {
		return { status: 'Error', message: safeMessage(error, [token]) };
	}
}

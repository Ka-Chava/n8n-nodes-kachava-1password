import type { IDataObject, IHttpRequestMethods, IHttpRequestOptions } from 'n8n-workflow';

import { isSecretReference } from '../shared/secretCache';

export type AuthPlacement = 'header' | 'query' | 'basic' | 'none';

export interface NameValue {
	name: string;
	value: string;
}

export interface RequestSpec {
	method: IHttpRequestMethods;
	url: string;
	authPlacement: AuthPlacement;
	/** Secret reference for header or query placement. */
	secretReference: string;
	headerName: string;
	valuePrefix: string;
	queryParameterName: string;
	/** Plain text or a secret reference. */
	basicUsername: string;
	basicPasswordReference: string;
	/** Values that start with op:// are resolved from 1Password. */
	headers: NameValue[];
	query: NameValue[];
	body?: IDataObject | IDataObject[];
	timeout: number;
}

export type Resolver = (reference: string) => Promise<string>;

export interface BuiltRequest {
	options: IHttpRequestOptions;
	/** Every resolved secret value, for redacting output and errors. */
	secrets: string[];
}

export class RequestSpecError extends Error {}

/**
 * Turns the node parameters into HTTP request options, resolving every
 * secret reference. Pure apart from the resolver, so it can be unit tested.
 */
export async function buildRequest(spec: RequestSpec, resolve: Resolver): Promise<BuiltRequest> {
	const secrets: string[] = [];
	const resolveTracked = async (reference: string): Promise<string> => {
		const value = await resolve(reference);
		secrets.push(value);
		return value;
	};
	const resolveIfReference = async (value: string): Promise<string> =>
		isSecretReference(value) ? await resolveTracked(value.trim()) : value;

	const url = spec.url.trim();
	if (!/^https?:\/\//i.test(url)) {
		throw new RequestSpecError('URL must start with http:// or https://');
	}

	const headers: IDataObject = {};
	for (const { name, value } of spec.headers) {
		if (name.trim()) headers[name.trim()] = await resolveIfReference(value);
	}
	const qs: IDataObject = {};
	for (const { name, value } of spec.query) {
		if (name.trim()) qs[name.trim()] = await resolveIfReference(value);
	}

	const options: IHttpRequestOptions = {
		method: spec.method,
		url,
		headers,
		qs,
		json: true,
		timeout: spec.timeout,
		returnFullResponse: true,
	};

	switch (spec.authPlacement) {
		case 'header': {
			const headerName = spec.headerName.trim();
			if (!headerName) throw new RequestSpecError('Header Name cannot be empty.');
			// Set last so the secret always wins over an extra header with the same name.
			headers[headerName] = `${spec.valuePrefix}${await resolveTracked(spec.secretReference)}`;
			break;
		}
		case 'query': {
			const parameter = spec.queryParameterName.trim();
			if (!parameter) throw new RequestSpecError('Query Parameter Name cannot be empty.');
			qs[parameter] = await resolveTracked(spec.secretReference);
			break;
		}
		case 'basic': {
			options.auth = {
				username: await resolveIfReference(spec.basicUsername),
				password: await resolveTracked(spec.basicPasswordReference),
			};
			break;
		}
		case 'none':
			break;
	}

	if (spec.body !== undefined) options.body = spec.body;

	return { options, secrets };
}

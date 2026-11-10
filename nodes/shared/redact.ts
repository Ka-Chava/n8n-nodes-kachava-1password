export const REDACTED = '[redacted by 1Password node]';

/** Secrets shorter than this are not redacted, to avoid mangling unrelated output. */
const MIN_REDACT_LENGTH = 6;

function usableSecrets(secrets: string[]): string[] {
	return [...new Set(secrets)]
		.filter((s) => s.length >= MIN_REDACT_LENGTH)
		.sort((a, b) => b.length - a.length);
}

export function redactString(text: string, secrets: string[]): string {
	let out = text;
	for (const secret of usableSecrets(secrets)) {
		out = out.split(secret).join(REDACTED);
		// Also catch the URL-encoded form, for secrets placed in query strings.
		const encoded = encodeURIComponent(secret);
		if (encoded !== secret) out = out.split(encoded).join(REDACTED);
		// And the JSON-escaped form, for secrets containing quotes, backslashes or
		// control characters inside serialized JSON.
		const jsonEscaped = JSON.stringify(secret).slice(1, -1);
		if (jsonEscaped !== secret) out = out.split(jsonEscaped).join(REDACTED);
	}
	return out;
}

/** Deep-redacts any occurrence of the given secrets in strings and object keys. */
export function redactValue<T>(value: T, secrets: string[]): T {
	if (usableSecrets(secrets).length === 0) return value;
	if (typeof value === 'string') return redactString(value, secrets) as T;
	if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets)) as T;
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[redactString(k, secrets)] = redactValue(v, secrets);
		}
		return out as T;
	}
	return value;
}

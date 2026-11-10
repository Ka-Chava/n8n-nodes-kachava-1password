import { describe, expect, it } from 'vitest';

import { REDACTED, redactString, redactValue } from '../nodes/shared/redact';

describe('redact', () => {
	it('replaces every occurrence of a secret in a string', () => {
		expect(redactString('a sk_live_123 b sk_live_123', ['sk_live_123'])).toBe(
			`a ${REDACTED} b ${REDACTED}`,
		);
	});

	it('replaces the URL-encoded form of a secret', () => {
		const secret = 'abc/def+ghi';
		expect(redactString(`https://x?k=${encodeURIComponent(secret)}`, [secret])).toBe(
			`https://x?k=${REDACTED}`,
		);
	});

	it('replaces longer secrets first so overlaps are fully hidden', () => {
		expect(redactString('token-abcdef-xyz', ['abcdef', 'token-abcdef-xyz'])).toBe(REDACTED);
	});

	it('ignores very short secrets', () => {
		expect(redactString('id 12345', ['12345'])).toBe('id 12345');
	});

	it('deep-redacts objects, arrays and keys', () => {
		const secret = 'super-secret-value';
		const input = {
			echo: secret,
			nested: [{ auth: `Bearer ${secret}` }, 3, null, true],
			[secret]: 'as key',
		};
		expect(redactValue(input, [secret])).toEqual({
			echo: REDACTED,
			nested: [{ auth: `Bearer ${REDACTED}` }, 3, null, true],
			[REDACTED]: 'as key',
		});
	});

	it('returns the same value when there is nothing to redact', () => {
		const input = { a: 1 };
		expect(redactValue(input, [])).toBe(input);
	});

	it('replaces the JSON-escaped form of a secret', () => {
		const secret = 'pa"ss\\word';
		const serialized = JSON.stringify({ key: secret });
		expect(serialized).not.toContain(secret);
		expect(redactString(serialized, [secret])).toBe(`{"key":"${REDACTED}"}`);
	});
});

// Cloud support is disabled on purpose: this package depends on @1password/sdk
// and node:crypto, which n8n Cloud's restricted-import rules forbid. It is only
// meant for self-hosted n8n.
import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default [
	...configWithoutCloudSupport,
	{
		// @1password/sdk is a real runtime dependency. Its core is a ~14 MB WASM
		// module loaded from disk, so bundling it into dist is fragile. Keeping it
		// as a normal dependency lets the consuming n8n repo pin it by lockfile
		// checksum. It has one dependency (@1password/sdk-core) and no install
		// scripts, so it installs under `npm ci --ignore-scripts`.
		files: ['package.json'],
		rules: {
			'@n8n/community-nodes/no-runtime-dependencies': 'off',
		},
	},
	{
		// Unit tests use obviously fake fixture values, never real secrets.
		files: ['test/**/*.ts'],
		rules: {
			'@n8n/community-nodes/no-hardcoded-secrets': 'off',
		},
	},
];

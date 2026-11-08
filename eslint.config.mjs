import serverConfig from 'eslint-config-nodebb';
import { defineConfig } from 'eslint/config';

// NodeBB's own server style (eslint-config-nodebb), applied to every file here.
// The shared config only targets NodeBB's paths and ES2020, so widen both.
export default defineConfig([
	{ ignores: ['node_modules/', '.test/'] },
	...serverConfig.map(block => ({
		...block,
		files: ['**/*.js'],
		languageOptions: { ...block.languageOptions, ecmaVersion: 'latest' },
	})),
	{
		// Integration tests poll and send requests whose order matters, on purpose.
		files: ['integration/**/*.js'],
		rules: { 'no-await-in-loop': 'off' },
	},
]);

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/generated/**', '**/.turbo/**', '**/*.cjs'] },
  {
    // The agent's window script and build scripts run in a browser / plain Node, not our TypeScript setup.
    ignores: [
      'apps/agent/src/ui/**',
      'apps/agent/scripts/**',
      'apps/agent/release/**',
      'apps/agent/vendor/**',
      'apps/api/scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // process.env may only be read through @print/config.
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.config.ts', '**/test/**', 'apps/agent/src/settings.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read configuration via @print/config.' },
      ],
    },
  },
);

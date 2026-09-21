// ESLint with typescript-eslint's type-aware rules (they catch, for example,
// promises nobody awaits). Each file is checked with its nearest tsconfig:
// src/tsconfig.json for the extension, tsconfig.json for tests and scripts.
// (A .mjs file, because ESLint needs an extra loader for a .ts config.)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
    globalIgnores(['extension/dist/', 'dist-packages/', 'test-results/', 'playwright-report/', '.e2e-profiles/', 'web-ext-artifacts/']),
    js.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
    },
    {
        // node:test's test() returns a promise the runner takes care of.
        files: ['test/unit/**/*.ts'],
        rules: {
            '@typescript-eslint/no-floating-promises': [
                'error',
                { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] }] },
            ],
        },
    },
    {
        files: ['**/*.mjs'],
        extends: [tseslint.configs.disableTypeChecked],
    },
);

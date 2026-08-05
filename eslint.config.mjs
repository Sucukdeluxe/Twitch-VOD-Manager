import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';

export default [
    js.configs.recommended,
    ...tseslint.configs.recommended,
    security.configs.recommended,
    {
        files: ['src/**/*.ts'],
        rules: {
            // Tune down noisy rules for existing codebase
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-console': 'off',
            'security/detect-object-injection': 'off', // Too many false positives with Record types
            'security/detect-non-literal-fs-filename': 'off', // All paths come from controlled sources
            'no-async-promise-executor': 'warn',
            'no-empty': ['warn', { allowEmptyCatch: true }],
        }
    },
    {
        ignores: ['dist/**', 'release/**', 'node_modules/**', 'scripts/**', 'tmp_*/**']
    }
];

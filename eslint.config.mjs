import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', '*.vsix'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { '@stylistic': stylistic, '@typescript-eslint': tseslint.plugin },
    rules: {
      '@stylistic/indent': ['error', 'tab'],
      '@stylistic/quotes': ['error', 'single'],
      '@stylistic/semi': ['error', 'always'],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  }
);

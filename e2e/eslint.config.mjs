import { defineConfig } from 'eslint/config';

import rootEslintConfig from '../eslint.root.mjs';

export default defineConfig([
  {
    extends: [rootEslintConfig],

    languageOptions: {
      sourceType: 'module',
    },

    rules: {
      // The whole workspace is test code, where AGENTS.md permits these.
      'id-length': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
    },
  },
]);

import eslintPluginVue from 'eslint-plugin-vue';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

import rootEslintConfig from '../../eslint.root.mjs';

export default defineConfig([
  globalIgnores(['vite.config.ts', 'vitest.config.ts', 'icons.config.ts', 'public']),
  {
    extends: [rootEslintConfig],

    languageOptions: {
      sourceType: 'module',
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },

    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@apps/api', '@apps/api/*', '**/apps/api/**'],
              message:
                'The web app talks to the api over HTTP. Importing it would ship entities, secrets and Node built-ins to the browser - share the contract through @libs/dto instead.',
            },
          ],
        },
      ],
    },
  },
  {
    extends: [...eslintPluginVue.configs['flat/recommended']],

    files: ['*.vue', '**/*.vue'],

    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',

      // `PropType` carries the type of a runtime prop declaration, and it is an assertion.
      '@typescript-eslint/consistent-type-assertions': 'off',

      // Vue ESLint does not handle types well so these are turned off for now
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
    },
  },
]);

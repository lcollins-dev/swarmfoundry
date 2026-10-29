import { defineConfig, globalIgnores } from 'eslint/config';

import rootEslintConfig, { namingConventionOptions } from '../../eslint.root.mjs';

const restrictedPackagePatterns = [
  {
    group: ['@apps/web', '@apps/web/*', '**/apps/web/**'],
    message:
      'The api serves the web app over HTTP and knows nothing of its components - share the contract through @libs/dto instead.',
  },
];

const apiPattern = {
  group: ['@/api', '@/api/**', '**/api', '**/api/**'],
  message:
    'api/ is the HTTP surface, one caller of core/. Reach the domain through core/ instead, so no other caller is handed the shape the web app reads.',
};

const dtoShapePattern = {
  group: ['@libs/dto'],
  importNamePattern: 'Dto$',
  message:
    'core/ answers in entities and its own types. A @libs/dto request or response is what one route wants, so parse and shape it in api/ - core takes only the enums its columns are typed in.',
};

// Nothing validates a request but the schema its route names.
const unparsedRequestSelector = {
  selector:
    "Decorator > CallExpression[callee.name=/^(Body|Query|Param|Headers)$/]:not(:has(NewExpression[callee.name='ZodPipe']))",
  message: 'Parse every body, query, param and header through a ZodPipe with its @libs/dto schema.',
};

/** Each block replaces the rule wholesale, so each repeats the package patterns every file has. */
const restrictImports = (...layerPatterns) => ({
  '@typescript-eslint/no-restricted-imports': ['error', { patterns: [...restrictedPackagePatterns, ...layerPatterns] }],
});

export default defineConfig([
  globalIgnores(['vitest.config.ts', 'vitest.integration.config.ts']),
  {
    extends: [rootEslintConfig],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off',
      'no-restricted-imports': 'off',
      'no-restricted-syntax': ['error', unparsedRequestSelector],
      ...restrictImports(),
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: restrictImports(apiPattern, dtoShapePattern),
  },
  {
    // GitLab's and Claude's wire keys are snake_case.
    files: [
      'src/core/actions/schema/run-result.ts',
      'src/core/actions/schema/assistant-message.ts',
      'src/core/issue-source/schema/gitlab.ts',
      'src/core/issue-source/gitlab-api.service.ts',
      'src/core/issue-source/*.test.ts',
      'src/core/runner/schema/gitlab-user.ts',
      'src/core/runner/schema/stream-json.ts',
      'src/core/task/schema/stream-json.ts',
      'src/core/task/*.test.ts',
      'integration/tests/task/*.ts',
      'src/core/runner/git-identity.service.test.ts',
    ],

    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        ...namingConventionOptions,
        {
          selector: ['objectLiteralProperty', 'typeProperty'],
          format: ['camelCase', 'PascalCase', 'UPPER_CASE', 'snake_case'],
        },
      ],
    },
  },
  {
    // `queryRunner.query` returns `any`, so naming a row's shape is the only way to read one.
    files: ['src/database/migrations/**/*.ts'],

    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
    },
  },
  {
    // `integration/` sits outside the build tsconfig's include, so it needs a project
    // that covers it for the type-aware rules to resolve. Must come after the block
    // above, which sets the project for everything else.
    files: ['integration/**/*.ts'],

    languageOptions: {
      parserOptions: {
        project: './tsconfig.integration.json',
      },
    },

    rules: {
      // supertest types a response body as `any`, so asserting against one trips the
      // unsafe-any family on almost every line. Production code stays strict.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
]);

import { existsSync } from 'node:fs';
import { z } from 'zod';

import { blankAsAbsent, cron, duration, flag, integer, text } from './config.builders';

export enum NodeEnv {
  DEVELOPMENT = 'development',
  PRODUCTION = 'production',
  TEST = 'test',
}

/** Keyed by the variable each setting is read from, so a rejected value names itself. */
const environment = z
  .object({
    // General
    VERSION: text('dev'),

    NODE_ENV: z.enum(NodeEnv).default(NodeEnv.DEVELOPMENT),
    PORT: integer(3000),

    WEB_APP_BASE_URL: z.string().min(1),

    // Blank leaves the built web app unserved, as in development where Vite serves it.
    WEB_ROOT_PATH: z.string().default(''),

    BLOCKED_AT_ENABLED: flag(false),
    BLOCKED_AT_THRESHOLD_MS: integer(1000),

    PAGE_SIZE: integer(20),

    TRUST_PROXY: text('loopback, linklocal, uniquelocal'),

    // Logs
    LOG_STDOUT_LEVEL: text('info'),
    LOG_STDOUT_PRETTY: flag(true),

    LOG_FILE_LEVEL: text('info'),
    LOG_FILE_PRETTY: flag(true),
    // Blank turns file logging off.
    LOG_FILE_PATH: z.string().default('logs'),
    LOG_FILE_NAME: text('all.log'),
    LOG_FILE_ROTATE_INTERVAL: text('1d'),
    LOG_FILE_ROTATE_MAX_SIZE: text('10M'),
    LOG_FILE_ROTATE_MAX_FILES: integer(5),

    // Database
    TYPEORM_HOST: z.string().min(1),
    TYPEORM_PORT: integer(5432),
    TYPEORM_USERNAME: text('swarmfoundry'),
    TYPEORM_PASSWORD: text('swarmfoundry'),
    TYPEORM_DATABASE: text('swarmfoundry'),
    TYPEORM_LOGGING: flag(false),
    TYPEORM_MIGRATIONS_RUN: flag(false),
    TYPEORM_USE_SSL: flag(false),

    USE_TEST_MIGRATIONS: flag(false),

    // Email
    EMAIL_TEMPLATES_PATH: text('email-templates'),

    EMAIL_FROM_ADDRESS: z.string().min(1),

    EMAIL_SMTP_HOST: z.string().default(''),
    EMAIL_SMTP_PORT: integer(587),
    EMAIL_SMTP_USERNAME: z.string().default(''),
    EMAIL_SMTP_PASSWORD: z.string().default(''),
    // Implicit TLS, as on port 465. Port 587 expects false and STARTTLS.
    EMAIL_SMTP_SECURE: flag(false),
    EMAIL_SMTP_STARTTLS: flag(true),

    EMAIL_SES_REGION: text('eu-west-2'),
    EMAIL_SES_ACCESS_KEY_ID: z.string().default(''),
    EMAIL_SES_SECRET_ACCESS_KEY: z.string().default(''),

    // Rate limiting
    RATE_LIMIT_WINDOW_SECS: integer(5),
    RATE_LIMIT_MAX_REQUESTS: integer(50),

    // Requests
    REQUEST_MAX_SIZE_JSON: text('8mb'),

    // User
    USER_TOKEN_SECRET: z.string().min(1),
    USER_TOKEN_EXPIRY: duration('24h'),

    USER_PASSWORD_HASH_ROUNDS: integer(8),

    USER_IDLE_TIMEOUT: duration('1h'),

    // Orchestrator
    // Blank reads swarmfoundry.yaml from the working directory if there is one. A path set here must exist. Ignored when
    // SWARMFOUNDRY_CONFIG_REPO is set.
    SWARMFOUNDRY_CONFIG: z.string().default(''),

    // Set, the config loads from SWARMFOUNDRY_CONFIG_BRANCH of this repo and follows it.
    SWARMFOUNDRY_CONFIG_REPO: blankAsAbsent(
      z
        .url({ protocol: /^https?$/ })
        // git's errors quote the URL.
        .refine(value => {
          const url = URL.parse(value);

          return url === null || (url.username === '' && url.password === '');
        }, 'must not hold a username or password; set SWARMFOUNDRY_CONFIG_TOKEN instead')
        .optional()
    ),
    // Required with the repo, so nobody follows a default branch by accident.
    SWARMFOUNDRY_CONFIG_BRANCH: blankAsAbsent(
      z
        .string()
        .regex(/^[A-Za-z0-9._/-]+$/, "must hold only letters, digits, '.', '_', '/' or '-'")
        .refine(value => !value.startsWith('-'), "must not start with '-'")
        .optional()
    ),
    // Blank is the repo root.
    SWARMFOUNDRY_CONFIG_PATH: z
      .string()
      .default('')
      .refine(
        value => !value.startsWith('/') && !value.split('/').includes('..'),
        "must be relative to the repo root, without '..'"
      ),
    SWARMFOUNDRY_CONFIG_POLL_INTERVAL: duration('60s'),
    // A read-only token for the repo. Blank sends none.
    SWARMFOUNDRY_CONFIG_TOKEN: z.string().default(''),
    // The last good revision is read from here when the head will not load at startup.
    SWARMFOUNDRY_CONFIG_CLONE_DIR: text('config-repo'),

    // Names and labels this orchestrator's sandboxes. Orchestrators sharing a Docker daemon need different values.
    SANDBOX_NAMESPACE: blankAsAbsent(
      z
        .string()
        .regex(
          /^[a-z0-9][a-z0-9_.-]*$/,
          "must start with a lowercase letter or digit and hold only those, '.', '_' or '-'"
        )
        .default('swarmfoundry')
    ),

    // Batch jobs
    BATCH_JOB_RUN_HISTORY_SIZE: integer(100, 1),

    BATCH_JOB_EXAMPLE_CRON: cron('0 * * * *'),
  })
  .superRefine((env, context) => {
    if (env.SWARMFOUNDRY_CONFIG_REPO !== undefined && env.SWARMFOUNDRY_CONFIG_BRANCH === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['SWARMFOUNDRY_CONFIG_BRANCH'],
        message: 'must be set when SWARMFOUNDRY_CONFIG_REPO is',
      });
    }
  });

export type IEnvConfig = z.infer<typeof environment>;

/** Settings whose value never reaches a log or an error message. */
export const SECRETS: readonly (keyof IEnvConfig)[] = [
  'USER_TOKEN_SECRET',
  'TYPEORM_PASSWORD',
  'EMAIL_SMTP_PASSWORD',
  'EMAIL_SES_SECRET_ACCESS_KEY',
  'SWARMFOUNDRY_CONFIG_TOKEN',
];

/** Reads `<NODE_ENV>.env` into `process.env`, leaving any variable already set. A missing file is accepted. */
function loadEnvFile(nodeEnv: string): void {
  const path = `${nodeEnv}.env`;

  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function configError(issues: readonly z.core.$ZodIssue[]): ConfigError {
  const reasons = issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');

  return new ConfigError(`Config validation error: ${reasons}`);
}

/** Loads the env file, then validates the environment or names every setting it rejected. */
export function parseEnvironment(): IEnvConfig {
  loadEnvFile(process.env.NODE_ENV ?? NodeEnv.DEVELOPMENT);

  const validated = environment.safeParse(process.env);

  if (!validated.success) {
    throw configError(validated.error.issues);
  }

  return validated.data;
}

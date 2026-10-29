import { Injectable } from '@nestjs/common';
import ms from 'ms';

import { type IEnvConfig, parseEnvironment, SECRETS } from './config.schema';

@Injectable()
export class ConfigService {
  private readonly env: IEnvConfig;

  constructor() {
    this.env = parseEnvironment();
  }

  /** The validated settings with every secret masked, safe to log. */
  get loggable(): Record<string, unknown> {
    const masked: Record<string, unknown> = { ...this.env };

    for (const secret of SECRETS) {
      masked[secret] = '[redacted]';
    }

    return masked;
  }

  // General
  get version() {
    return this.env.VERSION;
  }

  get nodeEnv() {
    return this.env.NODE_ENV;
  }

  get port() {
    return this.env.PORT;
  }

  get webAppBaseUrl() {
    return this.env.WEB_APP_BASE_URL;
  }

  get webRootPath() {
    return this.env.WEB_ROOT_PATH;
  }

  get blockedAtEnabled() {
    return this.env.BLOCKED_AT_ENABLED;
  }

  get blockedAtThresholdMs() {
    return this.env.BLOCKED_AT_THRESHOLD_MS;
  }

  get pageSize() {
    return this.env.PAGE_SIZE;
  }

  // Logs
  get logStdoutLevel() {
    return this.env.LOG_STDOUT_LEVEL;
  }

  get logStdoutPretty() {
    return this.env.LOG_STDOUT_PRETTY;
  }

  get logFileLevel() {
    return this.env.LOG_FILE_LEVEL;
  }

  get logFilePretty() {
    return this.env.LOG_FILE_PRETTY;
  }

  get logFilePath() {
    return this.env.LOG_FILE_PATH;
  }

  get logFileName() {
    return this.env.LOG_FILE_NAME;
  }

  get logFileRotateInterval() {
    return this.env.LOG_FILE_ROTATE_INTERVAL;
  }

  get logFileRotateMaxSize() {
    return this.env.LOG_FILE_ROTATE_MAX_SIZE;
  }

  get logFileRotateMaxFiles() {
    return this.env.LOG_FILE_ROTATE_MAX_FILES;
  }

  // Email
  get emailTemplatesPath() {
    return this.env.EMAIL_TEMPLATES_PATH;
  }

  get emailFromAddress() {
    return this.env.EMAIL_FROM_ADDRESS;
  }

  get emailSmtpHost() {
    return this.env.EMAIL_SMTP_HOST;
  }

  get emailSmtpPort() {
    return this.env.EMAIL_SMTP_PORT;
  }

  get emailSmtpUsername() {
    return this.env.EMAIL_SMTP_USERNAME;
  }

  get emailSmtpPassword() {
    return this.env.EMAIL_SMTP_PASSWORD;
  }

  get emailSmtpSecure() {
    return this.env.EMAIL_SMTP_SECURE;
  }

  get emailSmtpStarttls() {
    return this.env.EMAIL_SMTP_STARTTLS;
  }

  get emailSesRegion() {
    return this.env.EMAIL_SES_REGION;
  }

  get emailSesAccessKeyId() {
    return this.env.EMAIL_SES_ACCESS_KEY_ID;
  }

  get emailSesSecretAccessKey() {
    return this.env.EMAIL_SES_SECRET_ACCESS_KEY;
  }

  // Database
  get typeormHost() {
    return this.env.TYPEORM_HOST;
  }

  get typeormPort() {
    return this.env.TYPEORM_PORT;
  }

  get typeormUsername() {
    return this.env.TYPEORM_USERNAME;
  }

  get typeormPassword() {
    return this.env.TYPEORM_PASSWORD;
  }

  get typeormDatabase() {
    return this.env.TYPEORM_DATABASE;
  }

  get typeormMigrationsRun() {
    return this.env.TYPEORM_MIGRATIONS_RUN;
  }

  get typeormLogging() {
    return this.env.TYPEORM_LOGGING;
  }

  get typeormUseSSL() {
    return this.env.TYPEORM_USE_SSL;
  }

  get useTestMigrations() {
    return this.env.USE_TEST_MIGRATIONS;
  }

  // Rate limiting
  /** Express reads a number as a hop count and a string as a list of addresses, subnets and preset names. */
  get trustProxy(): number | string {
    const setting = this.env.TRUST_PROXY.trim();

    return /^\d+$/.test(setting) ? Number(setting) : setting;
  }

  get rateLimitWindowSecs() {
    return this.env.RATE_LIMIT_WINDOW_SECS;
  }

  get rateLimitMaxRequests() {
    return this.env.RATE_LIMIT_MAX_REQUESTS;
  }

  // Requests
  get requestMaxSizeJson() {
    return this.env.REQUEST_MAX_SIZE_JSON;
  }

  // User
  get userTokenSecret() {
    return this.env.USER_TOKEN_SECRET;
  }

  get userTokenExpiry() {
    return this.env.USER_TOKEN_EXPIRY;
  }

  get userPasswordHashRounds() {
    return this.env.USER_PASSWORD_HASH_ROUNDS;
  }

  get userIdleTimeout() {
    return this.env.USER_IDLE_TIMEOUT;
  }

  // Orchestrator
  get swarmfoundryConfig() {
    return this.env.SWARMFOUNDRY_CONFIG;
  }

  get configRepo() {
    return this.env.SWARMFOUNDRY_CONFIG_REPO;
  }

  get configBranch() {
    return this.env.SWARMFOUNDRY_CONFIG_BRANCH;
  }

  get configPath() {
    return this.env.SWARMFOUNDRY_CONFIG_PATH;
  }

  get configPollIntervalMs() {
    return ms(this.env.SWARMFOUNDRY_CONFIG_POLL_INTERVAL);
  }

  get configToken() {
    return this.env.SWARMFOUNDRY_CONFIG_TOKEN;
  }

  get configCloneDir() {
    return this.env.SWARMFOUNDRY_CONFIG_CLONE_DIR;
  }

  get sandboxNamespace() {
    return this.env.SANDBOX_NAMESPACE;
  }

  // Batch jobs
  get batchJobRunHistorySize() {
    return this.env.BATCH_JOB_RUN_HISTORY_SIZE;
  }

  get batchJobExampleCron() {
    return this.env.BATCH_JOB_EXAMPLE_CRON;
  }
}

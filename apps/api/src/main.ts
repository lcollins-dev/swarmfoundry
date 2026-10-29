import 'module-alias/register';

import { Logger } from '@nestjs/common';
import blockedAt from 'blocked-at';
import { inspect } from 'util';

import { ConfigService } from './config/config.service';

import { applyGlobalMiddleware, createApp } from './app';
import { ConfigError } from './config/config.schema';

const logger = new Logger('main');

/** Sysexits EX_CONFIG. */
const EXIT_CONFIG = 78;

async function bootstrap() {
  const app = await createApp();

  const configService = app.get(ConfigService);
  logger.debug({ config: configService.loggable }, 'bootstrap(): App config');

  // Blocked at
  if (configService.blockedAtEnabled) {
    logger.log({ thresholdMs: configService.blockedAtThresholdMs }, 'bootstrap(): Blocked at enabled');

    blockedAt(
      (time, stack) => {
        logger.warn({ time, stack }, `blockedAt(): Blocked for ${time}ms`);
      },
      { threshold: configService.blockedAtThresholdMs }
    );
  }

  applyGlobalMiddleware(app);
  app.enableShutdownHooks();

  await app.listen(configService.port).catch((error: unknown) => {
    try {
      logger.log({ error }, "bootstrap(): Couldn't bootstrap nest");
      app.flushLogs();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log("bootstrap(): Couldn't flush logs", inspect(error));
    }

    throw error;
  });

  logger.log(`bootstrap(): App started on port ${configService.port}`);
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // eslint-disable-next-line no-console
    console.log('bootstrap(): Configuration rejected', error.message);
    process.exit(EXIT_CONFIG);
  }

  // eslint-disable-next-line no-console
  console.log('bootstrap(): Application bootstrap failed', inspect(error));
  process.exit(1);
});

import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';
import { initializeTransactionalContext } from 'typeorm-transactional';

import { ExtendedBaseExceptionFilter } from './common/interceptors/ExtendedBaseExceptionFilter';

import { ConfigService } from './config/config.service';

import { AppModule } from './app.module';

export const createApp = async (): Promise<NestExpressApplication> => {
  initializeTransactionalContext();

  // Nest exits the process itself on a provider that throws unless this is off, which would take
  // the bootstrap error handling in main.ts with it.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(PinoLogger));

  return app;
};

export const applyGlobalMiddleware = (app: NestExpressApplication): void => {
  const configService = app.get(ConfigService);

  // The throttler keys on req.ip, which is the proxy's address unless the proxy is trusted to name the client.
  app.set('trust proxy', configService.trustProxy);

  app.use(helmet());
  app.useBodyParser('json', { limit: configService.requestMaxSizeJson });

  const { httpAdapter } = app.get(HttpAdapterHost);

  app.useGlobalFilters(new ExtendedBaseExceptionFilter(httpAdapter));
};

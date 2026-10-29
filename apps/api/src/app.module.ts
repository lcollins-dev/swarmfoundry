import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';

import { ConfigService } from './config/config.service';

import { ApiModule } from './api/api.module';
import { ConfigModule } from './config/config.module';
import { FoundryConfigModule } from './core/foundry-config/foundry-config.module';
import { IssueSourceModule } from './core/issue-source/issue-source.module';
import { TriggerEngineModule } from './core/trigger-engine/trigger-engine.module';
import { DatabaseModule } from './database/database.module';
import { EmailModule } from './email/email.module';
import { LoggerModule } from './logger/logger.module';

// serve-static tests `path + '/'`, so this covers `/api` too. An unknown api path gets Nest's JSON 404 rather than the
// web app.
const WEB_EXCLUDED_PATHS = ['/api/{*path}'];

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DatabaseModule,
    EmailModule,
    FoundryConfigModule,
    IssueSourceModule,
    TriggerEngineModule,
    ApiModule,
    ServeStaticModule.forRootAsync({
      useFactory: (configService: ConfigService) =>
        configService.webRootPath === ''
          ? []
          : [
              {
                rootPath: configService.webRootPath,
                exclude: WEB_EXCLUDED_PATHS,
              },
            ],
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}

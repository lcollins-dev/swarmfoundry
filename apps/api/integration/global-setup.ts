import { DataSource } from 'typeorm';

import { getDatabaseConfig, recreateDatabase } from './utils/database';
import { migrations, testMigrations } from '@/database/migrations';

export default async function setup(): Promise<void> {
  const config = getDatabaseConfig();

  await recreateDatabase(config);

  const dataSource = new DataSource({
    type: 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    migrations: [...migrations, ...testMigrations],
  });

  await dataSource.initialize();

  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}

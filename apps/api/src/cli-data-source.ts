import { DataSource } from 'typeorm';

import { migrations, testMigrations } from './database/migrations';

// eslint-disable-next-line @typescript-eslint/naming-convention
const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.TYPEORM_HOST,
  port: Number(process.env.TYPEORM_PORT),
  username: process.env.TYPEORM_USERNAME,
  password: process.env.TYPEORM_PASSWORD,
  database: process.env.TYPEORM_DATABASE,
  migrations: [...migrations, ...(process.env.USE_TEST_MIGRATIONS === 'true' ? testMigrations : [])],
  extra: {
    ssl: process.env.TYPEORM_USE_SSL === 'true',
  },
});

module.exports = {
  AppDataSource,
};

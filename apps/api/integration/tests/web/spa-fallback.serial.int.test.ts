import { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapApp } from '../../setup';

const INDEX_HTML = '<!doctype html><title>web app index</title>';
const ASSET_JS = 'console.log("asset");';

// WEB_ROOT_PATH is read once when the app is built, so this file owns its app.
describe('Web app serving (integration, serial)', () => {
  let app: NestExpressApplication;
  let webRoot: string;

  beforeAll(async () => {
    webRoot = mkdtempSync(join(tmpdir(), 'swarmfoundry-web-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), INDEX_HTML);
    writeFileSync(join(webRoot, 'assets', 'app.js'), ASSET_JS);

    process.env.WEB_ROOT_PATH = webRoot;

    app = await bootstrapApp();
  });

  afterAll(() => {
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('serves index.html at the root', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);

    expect(response.text).toBe(INDEX_HTML);
  });

  it('serves a built asset as itself', async () => {
    const response = await request(app.getHttpServer()).get('/assets/app.js').expect(200);

    expect(response.text).toBe(ASSET_JS);
  });

  it('falls back to index.html for a path outside /api', async () => {
    for (const path of ['/sign-in', '/admin/users/12', '/apis', '/api-docs']) {
      const response = await request(app.getHttpServer()).get(path).expect(200);

      expect(response.text).toBe(INDEX_HTML);
    }
  });

  it('answers an unknown path under /api with a json 404', async () => {
    for (const path of ['/api', '/api/', '/api/v1/does-not-exist', '/api/v2/does-not-exist?query=1']) {
      const response = await request(app.getHttpServer()).get(path).expect(404);

      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.body.statusCode).toBe(404);
    }
  });

  it('still routes an api path the api answers', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/availability').expect(200);

    expect(response.body).toEqual({ available: true });
  });

  it('answers a non-GET request for an unknown path with a 404', async () => {
    await request(app.getHttpServer()).post('/sign-in').expect(404);
  });
});

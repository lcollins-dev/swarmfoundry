import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { SourceWatermarkService } from '@/core/issue-source/source-watermark.service';

import { bootstrapApp } from '../../setup';

describe('Source watermarks (integration)', () => {
  let app: NestExpressApplication;
  let watermarks: SourceWatermarkService;

  const newSource = () => ({ name: `int-${randomUUID()}`, url: 'https://gitlab.test' });

  beforeAll(async () => {
    app = await bootstrapApp();
    watermarks = app.get(SourceWatermarkService);
  });

  it('finds none for a project never saved', async () => {
    await expect(watermarks.find('mergeRequest', newSource(), 7)).resolves.toBeNull();
  });

  it('replaces the saved watermark, keyed by source, GitLab and project whatever the trailing slash', async () => {
    const source = newSource();
    const other = { ...source, name: `${source.name}-other` };

    await watermarks.save(
      'mergeRequest',
      { ...source, url: `${source.url}/` },
      7,
      new Date('2026-10-22T11:00:00.000Z')
    );
    await watermarks.save('mergeRequest', source, 7, new Date('2026-10-22T12:00:00.000Z'));
    await watermarks.save('mergeRequest', source, 8, new Date('2026-10-22T13:00:00.000Z'));
    await watermarks.save('mergeRequest', other, 7, new Date('2026-10-22T14:00:00.000Z'));

    await expect(watermarks.find('mergeRequest', { ...source, url: `${source.url}//` }, 7)).resolves.toEqual(
      new Date('2026-10-22T12:00:00.000Z')
    );
    await expect(watermarks.find('mergeRequest', source, 8)).resolves.toEqual(new Date('2026-10-22T13:00:00.000Z'));
    await expect(watermarks.find('mergeRequest', other, 7)).resolves.toEqual(new Date('2026-10-22T14:00:00.000Z'));
    await expect(watermarks.find('mergeRequest', { ...source, url: 'https://elsewhere.test' }, 7)).resolves.toBeNull();
  });

  it("removes the source's rows for other projects and other URLs, and every row of sources not retained", async () => {
    const kept = newSource();
    const dropped = newSource();
    const at = new Date('2026-10-22T11:00:00.000Z');

    await watermarks.save('mergeRequest', kept, 7, at);
    await watermarks.save('mergeRequest', kept, 8, at);
    await watermarks.save('mergeRequest', { ...kept, url: 'https://old.test' }, 7, at);
    await watermarks.save('mergeRequest', dropped, 7, at);

    await watermarks.retainProjects('mergeRequest', kept, [7]);

    await expect(watermarks.find('mergeRequest', kept, 7)).resolves.toEqual(at);
    await expect(watermarks.find('mergeRequest', kept, 8)).resolves.toBeNull();
    await expect(watermarks.find('mergeRequest', { ...kept, url: 'https://old.test' }, 7)).resolves.toBeNull();
    await expect(watermarks.find('mergeRequest', dropped, 7)).resolves.toEqual(at);

    await watermarks.retainSources([kept.name]);

    await expect(watermarks.find('mergeRequest', dropped, 7)).resolves.toBeNull();

    await watermarks.retainProjects('mergeRequest', kept, []);

    await expect(watermarks.find('mergeRequest', kept, 7)).resolves.toBeNull();
  });

  it("removes only the named projects' rows under the source's URL", async () => {
    const source = newSource();
    const at = new Date('2026-10-22T11:00:00.000Z');

    await watermarks.save('mergeRequest', source, 7, at);
    await watermarks.save('mergeRequest', source, 8, at);
    await watermarks.save('mergeRequest', { ...source, url: 'https://old.test' }, 8, at);

    await watermarks.removeProjects('mergeRequest', source, [8]);

    await expect(watermarks.find('mergeRequest', source, 7)).resolves.toEqual(at);
    await expect(watermarks.find('mergeRequest', source, 8)).resolves.toBeNull();
    await expect(watermarks.find('mergeRequest', { ...source, url: 'https://old.test' }, 8)).resolves.toEqual(at);
  });

  it('keeps issue and merge request rows apart, and removes both with the source', async () => {
    const source = newSource();
    const issueAt = new Date('2026-10-22T11:00:00.000Z');
    const mergeRequestAt = new Date('2026-10-22T12:00:00.000Z');

    await watermarks.save('issue', source, 7, issueAt);
    await watermarks.save('mergeRequest', source, 7, mergeRequestAt);

    await expect(watermarks.find('issue', source, 7)).resolves.toEqual(issueAt);

    await watermarks.retainProjects('mergeRequest', source, []);
    await watermarks.removeProjects('mergeRequest', source, [7]);

    await expect(watermarks.find('issue', source, 7)).resolves.toEqual(issueAt);

    await watermarks.save('mergeRequest', source, 7, mergeRequestAt);
    await watermarks.retainProjects('issue', source, []);

    await expect(watermarks.find('issue', source, 7)).resolves.toBeNull();
    await expect(watermarks.find('mergeRequest', source, 7)).resolves.toEqual(mergeRequestAt);

    await watermarks.save('issue', source, 7, issueAt);
    await watermarks.retainSources([newSource().name]);

    await expect(watermarks.find('issue', source, 7)).resolves.toBeNull();
    await expect(watermarks.find('mergeRequest', source, 7)).resolves.toBeNull();
  });
});

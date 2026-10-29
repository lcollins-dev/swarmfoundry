import { Readable } from 'node:stream';
import { extract, type Headers } from 'tar-stream';
import { describe, expect, it } from 'vitest';

import { DIRECTORY_MODE, FILE_MODE, SandboxArchiveService } from './sandbox-archive.service';

const readEntries = async (archive: Buffer): Promise<{ header: Headers; content: string }[]> => {
  const entries: { header: Headers; content: string }[] = [];
  const reader = extract();

  Readable.from([archive]).pipe(reader);

  for await (const entry of reader) {
    const chunks: Buffer[] = [];

    for await (const chunk of entry) {
      chunks.push(chunk);
    }

    entries.push({ header: entry.header, content: Buffer.concat(chunks).toString('utf8') });
  }

  return entries;
};

describe('SandboxArchiveService', () => {
  const service = new SandboxArchiveService();

  it('writes each file root-owned and read-only, relative to /', async () => {
    const archive = await service.build([
      { path: '/foundry/prompt.md', content: 'Implement #5' },
      { path: '/etc/claude-code/managed-settings.json', content: '{}' },
    ]);

    const files = (await readEntries(archive)).filter(entry => entry.header.type === 'file');

    expect(files.map(entry => entry.header)).toMatchObject([
      { name: 'foundry/prompt.md', uid: 0, gid: 0, uname: 'root', gname: 'root', mode: FILE_MODE },
      { name: 'etc/claude-code/managed-settings.json', uid: 0, gid: 0, mode: FILE_MODE },
    ]);
    expect(files.map(entry => entry.content)).toEqual(['Implement #5', '{}']);
  });

  it('makes each parent directory root-owned and read-only too, before its files', async () => {
    const archive = await service.build([
      { path: '/foundry/prompt.md', content: 'a' },
      { path: '/foundry/system.md', content: 'b' },
    ]);

    const entries = await readEntries(archive);

    expect(entries.map(entry => entry.header.name)).toEqual(['foundry/', 'foundry/prompt.md', 'foundry/system.md']);
    expect(entries[0].header).toMatchObject({ type: 'directory', uid: 0, gid: 0, mode: DIRECTORY_MODE });
  });

  it.each(['foundry/prompt.md', '/foundry/../etc/passwd', '/'])('refuses the path %s', async path => {
    await expect(service.build([{ path, content: 'x' }])).rejects.toThrow(`Cannot copy into`);
  });
});

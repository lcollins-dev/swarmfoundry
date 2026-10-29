import { Injectable } from '@nestjs/common';
import { posix } from 'node:path';
import { pack } from 'tar-stream';

import type { ISandboxFile } from './runner.types';

export const FILE_MODE = 0o444;
export const DIRECTORY_MODE = 0o555;

/**
 * Builds the tar a sandbox's files are copied in with, extracted at `/`. Docker keeps a tar entry's owner, so every
 * entry is root's, and the agent cannot change or replace them.
 */
@Injectable()
export class SandboxArchiveService {
  async build(files: readonly ISandboxFile[]): Promise<Buffer> {
    const archive = pack();
    const mtime = new Date();
    const owner = { uid: 0, gid: 0, uname: 'root', gname: 'root', mtime };

    // An entry for each parent directory, so a directory the image left writable to the agent becomes root's too.
    const directories = new Set(files.map(file => this.entryName(posix.dirname(file.path))));

    for (const directory of directories) {
      archive.entry({ ...owner, name: `${directory}/`, type: 'directory', mode: DIRECTORY_MODE });
    }

    for (const file of files) {
      archive.entry({ ...owner, name: this.entryName(file.path), type: 'file', mode: FILE_MODE }, file.content);
    }

    archive.finalize();

    const chunks: Buffer[] = [];

    for await (const chunk of archive) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  /** Relative to `/`, where the archive is extracted. */
  private entryName(path: string): string {
    if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path === '/') {
      throw new Error(`Cannot copy into ${path}: give an absolute, normalised file path`);
    }

    return path.slice(1);
  }
}

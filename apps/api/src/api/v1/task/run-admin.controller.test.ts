import { MessageEvent } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { firstValueFrom, of, toArray } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TranscriptDirection, TranscriptEventType } from '@libs/dto';

import { TaskAdminService } from '@/api/v1/task/task-admin.service';
import { TranscriptStreamAdminService } from '@/api/v1/task/transcript-stream-admin.service';

import { RunAdminController } from '@/api/v1/task/run-admin.controller';

describe('RunAdminController', () => {
  let controller: RunAdminController;
  let getRunMock: ReturnType<typeof vi.fn>;
  let getTranscriptMock: ReturnType<typeof vi.fn>;
  let followTranscriptMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    getRunMock = vi.fn();
    getTranscriptMock = vi.fn();
    followTranscriptMock = vi.fn();

    const moduleRef = await Test.createTestingModule({
      controllers: [RunAdminController],
      providers: [
        { provide: TaskAdminService, useValue: { getRun: getRunMock, getTranscript: getTranscriptMock } },
        { provide: TranscriptStreamAdminService, useValue: { followTranscript: followTranscriptMock } },
      ],
    }).compile();

    controller = moduleRef.get(RunAdminController);
  });

  it('passes the parsed id through when fetching a run', async () => {
    getRunMock.mockResolvedValue({ id: 40 });

    await controller.getRun(40);

    expect(getRunMock).toHaveBeenCalledWith(40);
  });

  it.each([
    ['forward', { direction: TranscriptDirection.FORWARD, fromLine: 1, types: [TranscriptEventType.TOOL_CALL] }],
    ['backward', { direction: TranscriptDirection.BACKWARD, beforeLine: 30, types: undefined }],
  ])('passes the run and the parsed query through when reading a transcript %s', async (_direction, query) => {
    const page = { events: [], firstLine: 1, hasEarlier: false, nextLine: 1, hasMore: false };
    getTranscriptMock.mockResolvedValue(page);

    await expect(controller.getTranscript(40, query)).resolves.toBe(page);

    expect(getTranscriptMock).toHaveBeenCalledWith(40, query);
  });

  describe('streamTranscript', () => {
    it('follows from the last line the client holds, with its filter', async () => {
      followTranscriptMock.mockResolvedValue(of());

      await controller.streamTranscript(40, { types: [TranscriptEventType.TOOL_CALL] }, 12);

      expect(followTranscriptMock).toHaveBeenCalledWith({
        runId: 40,
        afterLine: 12,
        types: [TranscriptEventType.TOOL_CALL],
      });
    });

    it('follows from the first line for a client that holds none', async () => {
      followTranscriptMock.mockResolvedValue(of());

      await controller.streamTranscript(40, { types: undefined }, undefined);

      expect(followTranscriptMock).toHaveBeenCalledWith({ runId: 40, afterLine: 0, types: undefined });
    });

    it('ends the response once the lines end, rather than beating on', async () => {
      const line: MessageEvent = { id: '1', data: { type: 'line', lineNumber: 1, events: [] } };
      followTranscriptMock.mockResolvedValue(of(line));

      const stream = await controller.streamTranscript(40, { types: undefined }, undefined);

      await expect(firstValueFrom(stream.pipe(toArray()))).resolves.toEqual([line]);
    });
  });
});

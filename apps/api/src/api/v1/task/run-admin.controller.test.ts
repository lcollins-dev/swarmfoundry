import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TranscriptEventType } from '@libs/dto';

import { TaskAdminService } from '@/api/v1/task/task-admin.service';

import { RunAdminController } from '@/api/v1/task/run-admin.controller';

describe('RunAdminController', () => {
  let controller: RunAdminController;
  let getRunMock: ReturnType<typeof vi.fn>;
  let getTranscriptMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    getRunMock = vi.fn();
    getTranscriptMock = vi.fn();

    const moduleRef = await Test.createTestingModule({
      controllers: [RunAdminController],
      providers: [{ provide: TaskAdminService, useValue: { getRun: getRunMock, getTranscript: getTranscriptMock } }],
    }).compile();

    controller = moduleRef.get(RunAdminController);
  });

  it('passes the parsed id through when fetching a run', async () => {
    getRunMock.mockResolvedValue({ id: 40 });

    await controller.getRun(40);

    expect(getRunMock).toHaveBeenCalledWith(40);
  });

  it('passes the run and the parsed query through when reading a transcript', async () => {
    const page = { events: [], nextLine: 1, hasMore: false };
    getTranscriptMock.mockResolvedValue(page);
    const query = { fromLine: 1, types: [TranscriptEventType.TOOL_CALL] };

    await expect(controller.getTranscript(40, query)).resolves.toBe(page);

    expect(getTranscriptMock).toHaveBeenCalledWith(40, query);
  });
});

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { TriggerMatchService } from './trigger-match.service';

import type {
  IIssueTriggerConfig,
  IMergeRequestBlock,
  IMergeRequestTriggerConfig,
  IScheduleTriggerConfig,
} from '@/core/foundry-config/foundry-config.types';
import type {
  IIssueAssignment,
  IIssueChange,
  IIssueEvent,
  IIssueLabelEvent,
  IMergeRequestEvent,
} from '@/core/issue-source/issue-source.types';

const SOURCE = 'gitlab-local';

const trigger = (
  name: string,
  labels: string[],
  notLabels: string[] = [],
  source = SOURCE,
  anyAssignee: string[] = [],
  projects: string[] = []
) =>
  ({
    name,
    source: { name: source },
    issue: { labels, notLabels, anyAssignee, projects },
  }) as unknown as IIssueTriggerConfig;

const added = (id: number, label: string, createdAt = `2026-10-14T10:00:${String(id).padStart(2, '0')}Z`) =>
  ({ id, label, action: 'add', createdAt: new Date(createdAt), actor: 'ada' }) satisfies IIssueLabelEvent;

const removed = (id: number, label: string) => ({ ...added(id, label), action: 'remove' }) satisfies IIssueLabelEvent;

const assigned = (id: number, usernames: string[], createdAt = `2026-10-14T10:00:${String(id).padStart(2, '0')}Z`) =>
  ({ id, usernames, createdAt: new Date(createdAt), actor: 'ada' }) satisfies IIssueAssignment;

const labelChange = ({ id, createdAt, actor }: IIssueLabelEvent): IIssueChange => ({
  kind: 'label',
  id,
  createdAt,
  actor,
});

const assignmentChange = ({ id, createdAt, actor }: IIssueAssignment): IIssueChange => ({
  kind: 'assignment',
  id,
  createdAt,
  actor,
});

const event = (
  labels: string[],
  labelEvents: IIssueLabelEvent[],
  source = SOURCE,
  assignees: string[] = [],
  assignments: IIssueAssignment[] = []
): IIssueEvent => ({
  source,
  project: { id: 7, path: 'group/project', url: 'https://gitlab.test/group/project' },
  issue: {
    iid: 1,
    title: 'Issue 1',
    url: 'https://gitlab.test/group/project/-/issues/1',
    labels,
    author: 'ada',
    assignees,
    updatedAt: new Date(),
  },
  labelEvents,
  assignments,
});

describe('TriggerMatchService', () => {
  let service: TriggerMatchService;
  let warn: MockInstance<Logger['warn']>;
  let debug: MockInstance<Logger['debug']>;

  beforeEach(() => {
    service = new TriggerMatchService();
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('matching', () => {
    it('matches an issue carrying every issue.labels label', () => {
      const implement = trigger('implement', ['workflow::in-progress', 'type::feature']);

      const matches = service.match(
        event(
          ['type::feature', 'workflow::in-progress'],
          [added(1, 'type::feature'), added(2, 'workflow::in-progress')]
        ),
        [implement]
      );

      expect(matches.map(match => match.trigger.name)).toEqual(['implement']);
    });

    it('skips an issue missing one of the issue.labels labels', () => {
      const implement = trigger('implement', ['workflow::in-progress', 'type::feature']);

      expect(service.match(event(['workflow::in-progress'], [added(1, 'workflow::in-progress')]), [implement])).toEqual(
        []
      );
    });

    it('skips an issue carrying a issue.notLabels label', () => {
      const implement = trigger('implement', ['workflow::in-progress'], ['foundry::failed']);

      expect(
        service.match(event(['workflow::in-progress', 'foundry::failed'], [added(1, 'workflow::in-progress')]), [
          implement,
        ])
      ).toEqual([]);
    });

    it('skips a trigger on another source, even when the labels match', () => {
      const elsewhere = trigger('implement', ['workflow::in-progress'], [], 'gitlab-other');

      expect(service.match(event(['workflow::in-progress'], [added(1, 'workflow::in-progress')]), [elsewhere])).toEqual(
        []
      );
    });

    it('skips a scheduled trigger, which no issue event fires, without a warning', () => {
      const scheduled = {
        name: 'friction',
        source: { name: SOURCE },
        schedule: { cron: '0 9 * * 1', project: 'group/project' },
      } as unknown as IScheduleTriggerConfig;

      expect(service.match(event(['workflow::in-progress'], [added(1, 'workflow::in-progress')]), [scheduled])).toEqual(
        []
      );
      expect(warn).not.toHaveBeenCalled();
    });

    describe('with projects', () => {
      const labelled = event(['workflow::in-progress'], [added(1, 'workflow::in-progress')]);

      it('matches an issue on a listed project, in any case', () => {
        const scoped = trigger('implement', ['workflow::in-progress'], [], SOURCE, [], ['other/app', 'Group/Project']);

        expect(service.match(labelled, [scoped]).map(match => match.trigger.name)).toEqual(['implement']);
      });

      it('skips an issue on a project outside the list, even when the labels match', () => {
        const scoped = trigger('implement', ['workflow::in-progress'], [], SOURCE, [], ['other/app']);

        expect(service.match(labelled, [scoped])).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      });
    });

    it('matches every trigger the issue satisfies', () => {
      const triggers = [trigger('implement', ['workflow::in-progress']), trigger('notify', ['workflow::in-progress'])];

      const matches = service.match(event(['workflow::in-progress'], [added(1, 'workflow::in-progress')]), triggers);

      expect(matches.map(match => match.trigger.name)).toEqual(['implement', 'notify']);
    });

    describe('with anyAssignee', () => {
      const implement = trigger('implement', ['workflow::ready'], [], SOURCE, ['swarmfoundry-bot', 'ada']);
      const ready = added(1, 'workflow::ready');

      it.each(['swarmfoundry-bot', 'Ada'])('matches an issue assigned to %s, one of the listed users', assignee => {
        const matches = service.match(event(['workflow::ready'], [ready], SOURCE, [assignee, 'ann']), [implement]);

        expect(matches).toEqual([{ trigger: implement, change: labelChange(ready) }]);
      });

      it('skips an issue assigned to none of the listed users', () => {
        expect(service.match(event(['workflow::ready'], [ready], SOURCE, ['ann']), [implement])).toEqual([]);
        expect(service.match(event(['workflow::ready'], [ready]), [implement])).toEqual([]);
      });

      it('checks no assignee when the list is empty', () => {
        const unscoped = trigger('implement', ['workflow::ready']);

        expect(service.match(event(['workflow::ready'], [ready]), [unscoped])).toEqual([
          { trigger: unscoped, change: labelChange(ready) },
        ]);
      });

      it('keys a match on the second action, whether the label or the assignment came first', () => {
        const assignment = assigned(2, ['swarmfoundry-bot']);
        const labelledFirst = [
          event(['workflow::ready'], [ready]),
          event(['workflow::ready'], [ready], SOURCE, ['swarmfoundry-bot'], [assignment]),
        ];

        const earlyAssignment = assigned(1, ['swarmfoundry-bot']);
        const lateLabel = added(2, 'workflow::ready');
        const assignedFirst = [
          event([], [], SOURCE, ['swarmfoundry-bot'], [earlyAssignment]),
          event(['workflow::ready'], [lateLabel], SOURCE, ['swarmfoundry-bot'], [earlyAssignment]),
        ];

        expect(service.match(labelledFirst[0], [implement])).toEqual([]);
        expect(service.match(labelledFirst[1], [implement])).toEqual([
          { trigger: implement, change: assignmentChange(assignment) },
        ]);

        expect(service.match(assignedFirst[0], [implement])).toEqual([]);
        expect(service.match(assignedFirst[1], [implement])).toEqual([
          { trigger: implement, change: labelChange(lateLabel) },
        ]);
      });

      it('moves the key to the new assignment when the issue is unassigned and assigned again', () => {
        const again = assigned(3, ['Swarmfoundry-Bot']);
        const reassigned = event(
          ['workflow::ready'],
          [ready],
          SOURCE,
          ['swarmfoundry-bot'],
          [assigned(2, ['ann']), again]
        );

        expect(service.match(reassigned, [implement])[0]?.change).toEqual(assignmentChange(again));
      });

      it('ignores the assignment of a user outside the list', () => {
        const others = event(['workflow::ready'], [ready], SOURCE, ['swarmfoundry-bot', 'ann'], [assigned(2, ['ann'])]);

        expect(service.match(others, [implement])[0]?.change).toEqual(labelChange(ready));
      });

      it('ignores every assignment when the list is empty', () => {
        const unscoped = trigger('implement', ['workflow::ready']);
        const assignedLater = event(['workflow::ready'], [ready], SOURCE, ['ada'], [assigned(2, ['ada'])]);

        expect(service.match(assignedLater, [unscoped])[0]?.change).toEqual(labelChange(ready));
      });

      it('breaks a tie on time between a label event and an assignment by kind, as findNewer does', () => {
        const sameTime = '2026-10-14T10:00:00Z';
        const label = added(1, 'workflow::ready', sameTime);
        const assignment = assigned(9, ['ada'], sameTime);

        const matches = service.match(event(['workflow::ready'], [label], SOURCE, ['ada'], [assignment]), [implement]);

        expect(matches[0]?.change).toEqual(labelChange(label));
      });
    });

    it('queues nothing, and logs at debug only, when no change inside the window made the issue match', () => {
      const implement = trigger('implement', ['workflow::in-progress']);

      expect(service.match(event(['workflow::in-progress'], []), [implement])).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledOnce();
    });
  });

  describe('appliesTo', () => {
    const scheduled = {
      name: 'friction',
      source: { name: SOURCE },
      schedule: { cron: '0 9 * * 1', project: 'Group/Project' },
    } as unknown as IScheduleTriggerConfig;

    it('applies a schedule trigger to its own project only, in any case', () => {
      expect(service.appliesTo(scheduled, 'group/project')).toBe(true);
      expect(service.appliesTo(scheduled, 'group/other')).toBe(false);
    });
  });

  describe('mismatch', () => {
    const implement = trigger('implement', ['workflow::in-progress', 'ready'], ['foundry::failed', 'blocked']);

    const assigned = trigger('implement', ['ready'], ['blocked'], SOURCE, ['swarmfoundry-bot', 'ada']);

    it('is null for labels that match', () => {
      expect(
        service.mismatch({ labels: ['ready', 'workflow::in-progress', 'type::bug'], assignees: [] }, implement)
      ).toBeNull();
    });

    it('names every missing and every blocking label', () => {
      expect(service.mismatch({ labels: ['ready', 'foundry::failed', 'blocked'], assignees: [] }, implement)).toBe(
        'The issue lacks workflow::in-progress and carries foundry::failed, blocked'
      );
    });

    it.each(['swarmfoundry-bot', 'ADA'])('is null while %s, one of the listed users, is assigned', assignee => {
      expect(service.mismatch({ labels: ['ready'], assignees: [assignee] }, assigned)).toBeNull();
    });

    it('names every listed assignee alongside the labels when the issue has none of them', () => {
      expect(service.mismatch({ labels: ['blocked'], assignees: ['ann'] }, assigned)).toBe(
        'The issue lacks ready and carries blocked and is not assigned to swarmfoundry-bot or ada'
      );
    });
  });

  describe('dedup key', () => {
    const implement = trigger('implement', ['workflow::in-progress', 'type::feature']);

    const keyFor = (labelEvents: IIssueLabelEvent[]) =>
      service.match(event(['workflow::in-progress', 'type::feature'], labelEvents), [implement])[0]?.change.id;

    it('takes the latest add event among issue.labels', () => {
      expect(keyFor([added(1, 'workflow::in-progress'), added(2, 'type::feature')])).toBe(2);
    });

    it('ignores add events for labels outside issue.labels', () => {
      expect(keyFor([added(1, 'workflow::in-progress'), added(2, 'type::feature'), added(3, 'priority::high')])).toBe(
        2
      );
    });

    it('ignores remove events among issue.labels', () => {
      expect(keyFor([added(1, 'type::feature'), added(2, 'workflow::in-progress'), removed(3, 'type::feature')])).toBe(
        2
      );
    });

    it('moves to the new event when a label is removed and added again', () => {
      expect(
        keyFor([
          added(1, 'type::feature'),
          added(2, 'workflow::in-progress'),
          removed(3, 'workflow::in-progress'),
          added(4, 'workflow::in-progress'),
        ])
      ).toBe(4);
    });

    it('keeps the same key when an unrelated label changes', () => {
      expect(keyFor([added(1, 'workflow::in-progress'), added(2, 'type::feature'), removed(3, 'priority::high')])).toBe(
        2
      );
    });

    it('orders by time rather than by position in the list', () => {
      expect(
        keyFor([
          added(9, 'workflow::in-progress', '2026-10-14T11:00:00Z'),
          added(2, 'type::feature', '2026-10-14T10:00:00Z'),
        ])
      ).toBe(9);
    });

    it('breaks a tie on time by the higher id', () => {
      const sameTime = '2026-10-14T10:00:00Z';

      expect(keyFor([added(5, 'type::feature', sameTime), added(4, 'workflow::in-progress', sameTime)])).toBe(5);
    });

    describe('with notLabels', () => {
      const flagged = trigger('implement', ['workflow::ready'], ['foundry::failed', 'workflow::review']);

      const matchOf = (labels: string[], labelEvents: IIssueLabelEvent[]) =>
        service.match(event(labels, labelEvents), [flagged]);

      it('moves to the remove event when a notLabels flag is cleared and the issue then matches', () => {
        const cleared = removed(3, 'foundry::failed');

        expect(
          matchOf(['workflow::ready'], [added(1, 'workflow::ready'), added(2, 'foundry::failed'), cleared])
        ).toEqual([{ trigger: flagged, change: labelChange(cleared) }]);
      });

      it('queues nothing when the issue still fails the match once the flag is cleared', () => {
        expect(
          matchOf(
            ['workflow::in-progress'],
            [added(1, 'workflow::ready'), added(2, 'foundry::failed'), removed(3, 'foundry::failed')]
          )
        ).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      });

      it('takes the newer of a column move and a flag removal', () => {
        const flagThenMove = [added(1, 'foundry::failed'), removed(2, 'foundry::failed'), added(3, 'workflow::ready')];
        const moveThenFlag = [added(1, 'foundry::failed'), added(2, 'workflow::ready'), removed(3, 'foundry::failed')];

        expect(matchOf(['workflow::ready'], flagThenMove)[0]?.change).toEqual(labelChange(flagThenMove[2]));
        expect(matchOf(['workflow::ready'], moveThenFlag)[0]?.change).toEqual(labelChange(moveThenFlag[2]));
      });

      it('takes a later remove over an earlier add with a higher id', () => {
        const cleared = {
          ...added(3, 'foundry::failed', '2026-10-14T11:00:00Z'),
          action: 'remove',
        } satisfies IIssueLabelEvent;

        expect(matchOf(['workflow::ready'], [added(4, 'workflow::ready'), cleared])[0]?.change).toEqual(
          labelChange(cleared)
        );
      });

      it('breaks a tie on time between an add and a remove by the higher id', () => {
        const sameTime = '2026-10-14T10:00:00Z';
        const moved = added(4, 'workflow::ready', sameTime);
        const sentBack = { ...added(5, 'workflow::review', sameTime), action: 'remove' } satisfies IIssueLabelEvent;

        expect(matchOf(['workflow::ready'], [moved, sentBack])[0]?.change).toEqual(labelChange(sentBack));
      });

      it('ignores remove events for labels outside notLabels', () => {
        expect(
          matchOf(['workflow::ready'], [added(1, 'workflow::ready'), removed(2, 'priority::high')])[0]?.change.id
        ).toBe(1);
      });
    });
  });

  describe('matchMergeRequest', () => {
    const mergeRequestTrigger = (name: string, block: Partial<IMergeRequestBlock> = {}, source = SOURCE) =>
      ({
        name,
        source: { name: source },
        mergeRequest: { event: 'merged', labels: [], notLabels: [], projects: [], ...block },
      }) as unknown as IMergeRequestTriggerConfig;

    const mergeRequestEvent = (
      fields: Partial<IMergeRequestEvent['mergeRequest']> = {},
      kind: IMergeRequestEvent['event'] = 'merged',
      source = SOURCE
    ): IMergeRequestEvent => ({
      source,
      project: { id: 7, path: 'group/project', url: 'https://gitlab.test/group/project' },
      event: kind,
      mergeRequest: {
        iid: 2,
        title: 'Fix it (#1)',
        url: 'https://gitlab.test/group/project/-/merge_requests/2',
        sourceBranch: '1-fix-it',
        targetBranch: 'master',
        labels: [],
        ...fields,
      },
      relatedIssue: null,
    });

    const namesOf = (triggers: { name: string }[]) => triggers.map(matched => matched.name);

    it('matches every merge request trigger on the source for its event, and no other kind', () => {
      const triggers = [
        mergeRequestTrigger('merged'),
        mergeRequestTrigger('opened', { event: 'opened' }),
        mergeRequestTrigger('elsewhere', {}, 'gitlab-other'),
        trigger('implement', []),
        {
          name: 'friction',
          source: { name: SOURCE },
          schedule: { cron: '0 9 * * 1', project: 'group/project' },
        } as unknown as IScheduleTriggerConfig,
      ];

      expect(namesOf(service.matchMergeRequest(mergeRequestEvent(), triggers))).toEqual(['merged']);
      expect(namesOf(service.matchMergeRequest(mergeRequestEvent({}, 'opened'), triggers))).toEqual(['opened']);
    });

    it('matches the target branch exactly when the trigger names one', () => {
      const triggers = [mergeRequestTrigger('master', { targetBranch: 'master' }), mergeRequestTrigger('any')];

      expect(namesOf(service.matchMergeRequest(mergeRequestEvent({ targetBranch: 'release' }), triggers))).toEqual([
        'any',
      ]);
      expect(namesOf(service.matchMergeRequest(mergeRequestEvent(), triggers))).toEqual(['master', 'any']);
    });

    it('needs every label and none of notLabels', () => {
      const triggers = [mergeRequestTrigger('labelled', { labels: ['backend', 'ready'], notLabels: ['wip'] })];

      expect(service.matchMergeRequest(mergeRequestEvent({ labels: ['backend'] }), triggers)).toEqual([]);
      expect(service.matchMergeRequest(mergeRequestEvent({ labels: ['backend', 'ready', 'wip'] }), triggers)).toEqual(
        []
      );
      expect(
        namesOf(service.matchMergeRequest(mergeRequestEvent({ labels: ['ready', 'docs', 'backend'] }), triggers))
      ).toEqual(['labelled']);
    });

    it('matches a listed project in any case, and skips one outside the list', () => {
      const scoped = mergeRequestTrigger('scoped', { projects: ['Group/Project'] });
      const other = mergeRequestTrigger('other', { projects: ['other/app'] });

      expect(namesOf(service.matchMergeRequest(mergeRequestEvent(), [scoped, other]))).toEqual(['scoped']);
      expect(service.appliesTo(other, 'group/project')).toBe(false);
    });
  });
});

import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  type Relation,
} from 'typeorm';

import { Run } from './run.entity';
import { ConfigRevision } from '@/core/foundry-config/entities/config-revision.entity';

import { StepList, TaskStatus, type ITaskMergeRequest } from '../task.types';
import { ColumnNumericTransformer } from '@/common/transformers/ColumnNumericTransformer';
import type { MergeRequestEventKind } from '@/core/foundry-config/foundry-config.types';
import type { IIssue, IIssueChange, IssueChangeKind } from '@/core/issue-source/issue-source.types';

const CHANGE_COLUMNS = '"changeKind", "changeId", "changeDate"';

const MATCHED_ISSUE_COLUMNS = '"issueLabels", "issueAuthor", "issueAssignees"';

const MERGE_REQUEST_COLUMNS =
  '"mergeRequestIid", "mergeRequestEvent", "mergeRequestTitle", "mergeRequestUrl", "sourceBranch", "targetBranch"';

/** Holds each row to one kind. A merge request task holds its related issue's three columns, or none of them. */
const TASK_KIND_CHECK = [
  `("fireTime" IS NULL AND "cron" IS NULL AND num_nulls("projectId", "issueIid", "issueTitle", "issueUrl", ${CHANGE_COLUMNS}) = 0 AND num_nonnulls(${MERGE_REQUEST_COLUMNS}) = 0)`,
  `("fireTime" IS NOT NULL AND "cron" IS NOT NULL AND num_nonnulls("projectId", "issueIid", "issueTitle", "issueUrl", ${CHANGE_COLUMNS}, "changeActor", ${MATCHED_ISSUE_COLUMNS}, ${MERGE_REQUEST_COLUMNS}) = 0)`,
  `(num_nulls("projectId", ${MERGE_REQUEST_COLUMNS}) = 0 AND num_nonnulls("fireTime", "cron", ${CHANGE_COLUMNS}, "changeActor", ${MATCHED_ISSUE_COLUMNS}) = 0 AND num_nulls("issueIid", "issueTitle", "issueUrl") IN (0, 3))`,
].join(' OR ');

/**
 * The unique keys are the dedup rule: one task per issue change, however often the source emits it, one per fire time
 * of a scheduled trigger, however often the scheduler ticks, and one per merge request event. A scheduled task has no
 * issue or change, and a merge request task no change.
 */
@Entity()
@Unique('UQ_task_issue_change', ['triggerName', 'sourceName', 'projectId', 'issueIid', 'changeKind', 'changeId'])
@Unique('UQ_task_fire_time', ['triggerName', 'fireTime'])
@Unique('UQ_task_merge_request_event', [
  'triggerName',
  'sourceName',
  'projectId',
  'mergeRequestIid',
  'mergeRequestEvent',
])
@Check('CHK_task_kind', TASK_KIND_CHECK)
@Index('IDX_task_trigger_name_status_queued_date', ['triggerName', 'status', 'queuedDate'])
export class Task {
  constructor(fields: {
    triggerName: string;
    sourceName: string;
    projectId: number | null;
    projectPath: string;
    projectUrl: string;
    issueIid: number | null;
    issueTitle: string | null;
    issueUrl: string | null;
    /** An issue task's issue as the poll saw it when the trigger matched. */
    matchedIssue: Pick<IIssue, 'labels' | 'author' | 'assignees'> | null;
    change: IIssueChange | null;
    fireTime: Date | null;
    cron: string | null;
    mergeRequest: ITaskMergeRequest | null;
    queuedDate: Date;
  }) {
    this.triggerName = fields.triggerName;
    this.sourceName = fields.sourceName;

    this.projectId = fields.projectId;
    this.projectPath = fields.projectPath;
    this.projectUrl = fields.projectUrl;

    this.issueIid = fields.issueIid;
    this.issueTitle = fields.issueTitle;
    this.issueUrl = fields.issueUrl;

    this.issueLabels = fields.matchedIssue?.labels ?? null;
    this.issueAuthor = fields.matchedIssue?.author ?? null;
    this.issueAssignees = fields.matchedIssue?.assignees ?? null;

    this.changeKind = fields.change?.kind ?? null;
    this.changeId = fields.change?.id ?? null;
    this.changeDate = fields.change?.createdAt ?? null;
    this.changeActor = fields.change?.actor ?? null;

    this.fireTime = fields.fireTime;
    this.cron = fields.cron;

    this.mergeRequestIid = fields.mergeRequest?.iid ?? null;
    this.mergeRequestEvent = fields.mergeRequest?.event ?? null;
    this.mergeRequestTitle = fields.mergeRequest?.title ?? null;
    this.mergeRequestUrl = fields.mergeRequest?.url ?? null;
    this.sourceBranch = fields.mergeRequest?.sourceBranch ?? null;
    this.targetBranch = fields.mergeRequest?.targetBranch ?? null;

    this.status = TaskStatus.QUEUED;
    this.list = StepList.STEPS;
    this.step = 0;
    this.queuedDate = fields.queuedDate;
    this.notBeforeDate = null;
    this.endDate = null;

    this.configId = null;

    this.cancelReason = null;
  }

  @PrimaryGeneratedColumn({ type: 'int4' })
  id!: number;

  @Column({ type: 'text' })
  triggerName: string;

  @Column({ type: 'text' })
  sourceName: string;

  /** Null for a scheduled task, which names its project by path alone. */
  @Column({ type: 'int4', nullable: true })
  projectId: number | null;

  @Column({ type: 'text' })
  projectPath: string;

  @Column({ type: 'text' })
  projectUrl: string;

  @Column({ type: 'int4', nullable: true })
  issueIid: number | null;

  @Column({ type: 'text', nullable: true })
  issueTitle: string | null;

  @Column({ type: 'text', nullable: true })
  issueUrl: string | null;

  /** The issue's labels when its trigger matched. Null for a task of another kind or one queued before they were kept. */
  @Column({ type: 'text', array: true, nullable: true })
  issueLabels: string[] | null;

  /** A username, as `issueLabels` is kept. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  issueAuthor: string | null;

  /** Usernames, as `issueLabels` is kept. */
  @Column({ type: 'text', array: true, nullable: true })
  issueAssignees: string[] | null;

  /** The kind of change that made the issue match, which `changeId` is unique within. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  changeKind: IssueChangeKind | null;

  /** The label event's id, or the assignment's system note id. */
  @Column({ type: 'int8', nullable: true, transformer: new ColumnNumericTransformer() })
  changeId: number | null;

  /** GitLab's time of the change, which orders tasks for one issue, since ids of two kinds do not compare. */
  @Column({ type: 'timestamp', nullable: true })
  changeDate: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  changeActor: string | null;

  /** The fire time of the scheduled trigger this task was queued for. */
  @Column({ type: 'timestamp', nullable: true })
  fireTime: Date | null;

  /** The cron expression `fireTime` came from, so a changed cron is told apart from downtime. */
  @Column({ type: 'text', nullable: true })
  cron: string | null;

  @Column({ type: 'int4', nullable: true })
  mergeRequestIid: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  mergeRequestEvent: MergeRequestEventKind | null;

  @Column({ type: 'text', nullable: true })
  mergeRequestTitle: string | null;

  @Column({ type: 'text', nullable: true })
  mergeRequestUrl: string | null;

  @Column({ type: 'text', nullable: true })
  sourceBranch: string | null;

  @Column({ type: 'text', nullable: true })
  targetBranch: string | null;

  @Column({ type: 'varchar', length: 16 })
  status: TaskStatus;

  /** `failureSteps` once the task has failed for good. */
  @Column({ type: 'varchar', length: 16, default: StepList.STEPS })
  list: StepList;

  /** The index in `list` of the step running, or of the one to run next while queued. */
  @Column({ type: 'int4', default: 0 })
  step: number;

  /** Queued tasks of a trigger start in this order. */
  @Column({ type: 'timestamp' })
  queuedDate: Date;

  /** A queued task waits for a slot and for this time, such as a retry's backoff. */
  @Column({ type: 'timestamp', nullable: true })
  notBeforeDate: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  endDate: Date | null;

  /** The config revision its first run started on, which its later runs use. Null in local file mode. */
  @Column({ type: 'int4', nullable: true })
  configId: number | null;

  @JoinColumn()
  @ManyToOne(() => ConfigRevision, { onDelete: 'RESTRICT' })
  config?: Relation<ConfigRevision>;

  @Column({ type: 'text', nullable: true })
  cancelReason: string | null;

  @OneToMany(() => Run, run => run.task)
  runs?: Relation<Run[]>;
}

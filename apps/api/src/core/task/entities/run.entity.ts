import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, type Relation } from 'typeorm';

import { Task } from './task.entity';
import { ConfigRevision } from '@/core/foundry-config/entities/config-revision.entity';

import { DeploymentFault, RunEndReason, RunOutcome, StepList, type IRunAgent } from '../task.types';
import { ColumnNumericTransformer } from '@/common/transformers/ColumnNumericTransformer';
import type { IResolvedAgent } from '@/core/foundry-config/foundry-config.types';

@Entity()
@Unique('UQ_run_task_id_list_step_number', ['taskId', 'list', 'step', 'number'])
export class Run {
  constructor(fields: {
    taskId: number;
    number: number;
    list: StepList;
    step: number;
    startDate: Date;
    configId: number | null;
    /** Null for a step that runs no agent. */
    agent: IRunAgent | null;
  }) {
    this.taskId = fields.taskId;
    this.number = fields.number;
    this.list = fields.list;
    this.step = fields.step;
    this.configId = fields.configId;

    this.agentName = fields.agent?.name ?? null;
    this.agentModel = fields.agent?.model ?? null;
    this.agentAuth = fields.agent?.auth ?? null;

    this.startDate = fields.startDate;
    this.endDate = null;

    this.containerId = null;
    this.exitCode = null;
    this.result = null;
    this.error = null;
    this.deploymentFault = null;
    this.outcome = null;
    this.endReason = null;

    this.turns = null;
    this.inputTokens = null;
    this.outputTokens = null;
    this.cacheReadTokens = null;
    this.cacheWriteTokens = null;
    this.costUsd = null;
  }

  @PrimaryGeneratedColumn({ type: 'int4' })
  id!: number;

  @Column({ type: 'int4' })
  taskId: number;

  @JoinColumn()
  @ManyToOne(() => Task, task => task.runs, { onDelete: 'CASCADE' })
  task?: Relation<Task>;

  /** The try of its step, 1-based. A retry of the step is the next number. */
  @Column({ type: 'int4' })
  number: number;

  @Column({ type: 'varchar', length: 16, default: StepList.STEPS })
  list: StepList;

  /** The index of the step in `list`. */
  @Column({ type: 'int4', default: 0 })
  step: number;

  /** Null in local file mode. */
  @Column({ type: 'int4', nullable: true })
  configId: number | null;

  @JoinColumn()
  @ManyToOne(() => ConfigRevision, { onDelete: 'RESTRICT' })
  config?: Relation<ConfigRevision>;

  /** Null for a static step, and for a run started before the agent was kept. */
  @Column({ type: 'text', nullable: true })
  agentName: string | null;

  @Column({ type: 'text', nullable: true })
  agentModel: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  agentAuth: IResolvedAgent['auth'] | null;

  @Column({ type: 'timestamp' })
  startDate: Date;

  @Column({ type: 'timestamp', nullable: true })
  endDate: Date | null;

  /** Restart recovery looks the sandbox up by it. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  containerId: string | null;

  @Column({ type: 'int4', nullable: true })
  exitCode: number | null;

  /** An agent step's stream-json `result` line, or what a static step did or why it had nothing to do. */
  @Column({ type: 'text', nullable: true })
  result: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  /** The runner's view once the report is stored, then the judgement's. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  deploymentFault: DeploymentFault | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  outcome: RunOutcome | null;

  /** The runner's view once the report is stored, then the judgement's. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  endReason: RunEndReason | null;

  // Usage, copied from an agent step's `result` line. Null without one, or where the line lacks the field.

  @Column({ type: 'int4', nullable: true })
  turns: number | null;

  @Column({ type: 'int8', nullable: true, transformer: new ColumnNumericTransformer() })
  inputTokens: number | null;

  @Column({ type: 'int8', nullable: true, transformer: new ColumnNumericTransformer() })
  outputTokens: number | null;

  @Column({ type: 'int8', nullable: true, transformer: new ColumnNumericTransformer() })
  cacheReadTokens: number | null;

  @Column({ type: 'int8', nullable: true, transformer: new ColumnNumericTransformer() })
  cacheWriteTokens: number | null;

  /** API-equivalent for an `oauth` agent, which is not billed per token. */
  @Column({ type: 'numeric', nullable: true, transformer: new ColumnNumericTransformer() })
  costUsd: number | null;
}

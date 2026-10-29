import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { ConfigRevisionStatus, type IConfigIssue } from '../foundry-config.types';

@Entity()
@Unique('UQ_config_revision_sha', ['sha'])
export class ConfigRevision {
  constructor(fields: { sha: string; status: ConfigRevisionStatus; errors: IConfigIssue[]; seenDate: Date }) {
    this.sha = fields.sha;
    this.status = fields.status;
    this.errors = fields.errors;
    this.seenDate = fields.seenDate;
    this.currentDate = null;
  }

  @PrimaryGeneratedColumn({ type: 'int4' })
  id!: number;

  @Column({ type: 'varchar', length: 64 })
  sha: string;

  /** The latest load's verdict, as are `errors`. */
  @Column({ type: 'varchar', length: 16 })
  status: ConfigRevisionStatus;

  @Column({ type: 'jsonb' })
  errors: IConfigIssue[];

  /** The first load's. */
  @Column({ type: 'timestamp' })
  seenDate: Date;

  /** The first time it became the running config. */
  @Column({ type: 'timestamp', nullable: true })
  currentDate: Date | null;
}

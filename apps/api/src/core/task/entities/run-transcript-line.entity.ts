import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';

import { Run } from './run.entity';

/** Kept as written, so a line that fails to parse is kept too. */
@Entity()
export class RunTranscriptLine {
  constructor(fields: { runId: number; lineNumber: number; line: string }) {
    this.runId = fields.runId;
    this.lineNumber = fields.lineNumber;
    this.line = fields.line;
  }

  @PrimaryColumn({ type: 'int4' })
  runId: number;

  @JoinColumn()
  @ManyToOne(() => Run, { onDelete: 'CASCADE' })
  run?: Relation<Run>;

  @PrimaryColumn({ type: 'int4' })
  lineNumber: number;

  @Column({ type: 'text' })
  line: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdDate!: Date;
}

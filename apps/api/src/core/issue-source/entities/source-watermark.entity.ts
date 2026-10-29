import { Column, Entity, PrimaryColumn } from 'typeorm';

export type WatermarkKind = 'issue' | 'mergeRequest';

/**
 * Where a source's issue or merge request polling of one project resumes. Keyed by the source and the GitLab's URL too,
 * so two sources on one project never share a row and a source moved to another GitLab starts afresh.
 */
@Entity()
export class SourceWatermark {
  constructor(fields: {
    kind: WatermarkKind;
    sourceName: string;
    gitlabUrl: string;
    projectId: number;
    watermark: Date;
  }) {
    this.kind = fields.kind;
    this.sourceName = fields.sourceName;
    this.gitlabUrl = fields.gitlabUrl;
    this.projectId = fields.projectId;
    this.watermark = fields.watermark;
  }

  @PrimaryColumn({ type: 'varchar', length: 16 })
  kind: WatermarkKind;

  @PrimaryColumn({ type: 'text' })
  sourceName: string;

  @PrimaryColumn({ type: 'text' })
  gitlabUrl: string;

  @PrimaryColumn({ type: 'int4' })
  projectId: number;

  @Column({ type: 'timestamp' })
  watermark: Date;
}

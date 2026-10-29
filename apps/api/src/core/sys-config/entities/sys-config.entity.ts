import { Entity, Column, PrimaryColumn } from 'typeorm';

export enum SysConfigId {
  REGISTRATION_ENABLED = 100,
}

@Entity()
export class SysConfig {
  constructor(id: SysConfigId, valueJson: string) {
    this.id = id;
    this.valueJson = valueJson;
  }

  @PrimaryColumn({ type: 'int4' })
  id: SysConfigId;

  @Column({ type: 'text' })
  valueJson: string;
}

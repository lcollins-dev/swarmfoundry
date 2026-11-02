import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';

import { User } from '@/core/user/entities/user.entity';

@Entity()
export class ApiKey {
  constructor(fields: { keyId: string; name: string; secretHash: string; userId: number }) {
    this.keyId = fields.keyId;
    this.name = fields.name;
    this.secretHash = fields.secretHash;
    this.userId = fields.userId;

    this.lastUsedDate = null;
  }

  @PrimaryGeneratedColumn({ type: 'int4' })
  id!: number;

  /** The public half of the credential. It selects the row a presented key is checked against. */
  @Column({ type: 'varchar', length: 32, unique: true })
  keyId: string;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  @Column({ type: 'varchar', length: 64 })
  secretHash: string;

  @Column({ type: 'int4' })
  userId: number;

  /** Stamped at most once per `LAST_USED_STAMP_INTERVAL_MS`. */
  @Column({ type: 'timestamp', nullable: true })
  lastUsedDate: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdDate!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: Relation<User>;
}

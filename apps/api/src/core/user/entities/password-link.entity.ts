import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';

import { User } from './user.entity';

/** Holds the SHA-256 of its token, never the token itself. */
@Entity()
export class PasswordLink {
  constructor(fields: { tokenHash: string; userId: number; expiresAt: Date }) {
    this.tokenHash = fields.tokenHash;
    this.userId = fields.userId;
    this.expiresAt = fields.expiresAt;
    this.usedAt = null;
  }

  @PrimaryGeneratedColumn({ type: 'int4' })
  id!: number;

  @Column({ type: 'varchar', length: 64, unique: true })
  tokenHash: string;

  @Column({ type: 'int4' })
  userId: number;

  @JoinColumn()
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user?: Relation<User>;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  usedAt: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdDate!: Date;
}

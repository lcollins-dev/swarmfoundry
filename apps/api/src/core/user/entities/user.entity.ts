import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
  CreateDateColumn,
  OneToMany,
  type Relation,
} from 'typeorm';

import { UserUserRole } from './user-user-role.entity';

@Entity()
export class User {
  constructor(fields: { name: string; email: string; passwordHash: string; mustChangePassword?: boolean }) {
    this.sessionUuid = null;

    this.name = fields.name;
    this.email = fields.email;
    this.passwordHash = fields.passwordHash;

    this.enabled = true;
    this.mustChangePassword = fields.mustChangePassword ?? false;

    this.lastLoginSuccess = null;
    this.lastLoginFail = null;
  }

  @PrimaryGeneratedColumn({ type: 'int4' })
  id!: number;

  @Column({ type: 'varchar', length: 256 })
  name: string;

  @Column({ type: 'varchar', length: 512 })
  email: string;

  @Column({ type: 'varchar', length: 256 })
  passwordHash: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  sessionUuid: string | null;

  @Column({ type: 'bool' })
  enabled: boolean;

  /** Holds the account to first-time setup; only a password change clears it. */
  @Column({ type: 'bool', default: false })
  mustChangePassword: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginSuccess: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginFail: Date | null;

  @UpdateDateColumn({ type: 'timestamp' })
  lastAccess!: Date;

  @CreateDateColumn({ type: 'timestamp' })
  createdDate!: Date;

  @OneToMany(() => UserUserRole, userUserRole => userUserRole.user)
  userUserRoles?: Relation<UserUserRole[]>;
}

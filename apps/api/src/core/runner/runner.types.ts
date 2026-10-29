import type { StringDecoder } from 'node:string_decoder';

import type { RunTranscriptLine } from '@/core/task/entities/run-transcript-line.entity';

import type { IRunUsage, StepList } from '@/core/task/task.types';

export const DOCKER_CLIENT = Symbol('DOCKER_CLIENT');

/** On every container and network a run creates, so restart recovery finds them without the database. */
export enum SandboxLabel {
  NAMESPACE = 'swarmfoundry.namespace',
  TASK_ID = 'swarmfoundry.task-id',
  RUN_ID = 'swarmfoundry.run-id',
  ROLE = 'swarmfoundry.role',
  SERVICE = 'swarmfoundry.service',
}

export enum SandboxRole {
  AGENT = 'agent',
  SERVICE = 'service',
  CLI_CHECK = 'cli-check',
  RUN_NETWORK = 'run-network',
  EGRESS_NETWORK = 'egress-network',
}

export type StopSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

/** A task is one label change; a run is one execution of one of its steps. */
export interface ISandboxIds {
  taskId: number;
  runId: number;
  runNumber: number;
  list: StepList;
  step: number;
}

export interface ISandboxFile {
  /** Absolute, inside the container. */
  path: string;
  content: string;
}

export interface IServiceContainerOptions {
  name: string;
  image: string;
  env: Readonly<Record<string, string>>;
  network: string;
  alias: string;
  labels: Record<string, string>;
}

export interface IAgentContainerOptions {
  runId: number;
  name: string;
  image: string;
  env: string[];
  network: string;
  mounts: readonly { source: string; target: string; readOnly: boolean }[];
  cpus?: number;
  memoryBytes?: number;
  pidsLimit: number;
  labels: Record<string, string>;
}

export interface ICpuMove {
  runId: number;
  container: string;
  cores: readonly number[];
}

export interface IOutputSinks {
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
}

export interface IAttachedOutput {
  /** Resolves once the stream ends, errors or is detached, never rejecting. */
  ended: Promise<void>;
}

export interface ISandboxContainer {
  id: string;
  name: string;
  role: SandboxRole | null;
  taskId: number | null;
  runId: number | null;

  /** Docker's: `created` (never started), `running`, `exited` and so on. */
  state: string;
}

export interface ISandboxNetwork {
  id: string;
  role: SandboxRole | null;
  runId: number | null;
}

export interface IAgentOutput {
  runId: number;

  /** Lines up to this number are already stored, so they are read for events but not stored again. */
  storedLineCount: number;

  extraSecrets: readonly string[];
  enabledPlugins: readonly string[];

  stdoutDecoder: StringDecoder;
  stdoutPartial: string;
  stderrDecoder: StringDecoder;
  stderrPartial: string;

  lineCount: number;
  pendingLines: RunTranscriptLine[];
  writing: Promise<void> | null;
  writeError: string | null;

  /** Null until `system/init`. */
  loadedPlugins: string[] | null;
  failedInstalls: string[];
  result: string | null;
  /** From the raw `result` line, with `result`. */
  usage: IRunUsage | null;

  stderrTail: string[];

  /** Each Bash call's command, redacted and cut short, by tool use id until its result. */
  bashCommands: Map<string, string>;
}

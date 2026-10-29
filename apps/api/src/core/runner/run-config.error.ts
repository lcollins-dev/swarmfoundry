/** Fails the run for good, since no retry fixes a config fault such as a missing variable or a refused token. */
export class RunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = RunConfigError.name;
  }
}

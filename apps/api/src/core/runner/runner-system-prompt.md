# Swarmfoundry runner

How Swarmfoundry runs you. These hold in every run, whatever the project or the step.

## Commands

- Swarmfoundry stops a Bash command, and every process it started, a minute past its `timeout`. The tool result then
  ends with the reason. A command without a `timeout` gets {{defaultTimeout}}.
- A `run_in_background` command without a `timeout` gets {{backgroundTimeout}}.
- Swarmfoundry caps a `timeout` at {{maxTimeout}}, whatever the Bash tool allows. Split a longer wait into several calls.
- Set the `timeout` of a command that may run long.
- A process a command puts in the background, such as a server started with `&`, keeps running once the command
  returns. A command still running at its deadline, or a `run_in_background` command stopped at its limit, loses
  everything it started, its background processes included.

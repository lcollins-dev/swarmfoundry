<div align="center">
  <img src="apps/web/public/favicon.svg" width="96" height="96" alt="" />
  <h1>Swarmfoundry</h1>
  <h3>Turn a GitLab issue board into work for sandboxed Claude Code agents</h3>
</div>

Swarmfoundry watches GitLab projects and starts Claude Code agents when issues match your triggers, such as a label
and an assignee. Each agent runs in its own Docker container, clones the project and follows your prompt to do the
work, open a merge request and update the issue. You review and merge.

I built it to let agents work through my backlog unattended, freeing up my time to focus on the bigger picture.
You configure the triggers, prompts, agent settings and sandbox images for your workflow, whether that is
implementation and review, triage or scheduled jobs.

> **Note:** Swarmfoundry is in early development and has not been widely tested. The documentation is still evolving.
> Agents run with Claude's permission checks off inside their sandboxes. Read the [deployment guide](DEPLOYMENT.md)
> before deploying it.

## Features

- Trigger work from issue labels and assignees, merged merge requests or cron schedules in selected projects.
- Run each agent step in a fresh container with CPU and memory limits, configured mounts and sidecar services on a
  private network.
- Check the labels left by a run, retry infrastructure failures and report failed runs on the issue.
- Stop an agent command, and every process it started, a minute past its timeout, so a hung command cannot hold a run
  open.
- Start one task per matching change. Clear a blocking flag to re-run it.
- Relabel, comment or assign with static steps that need no agent.
- Load config from a local directory or track a repository branch. Each task uses the revision it started with.
- Follow tasks, runs and transcripts live in a web console, and browse the triggers, queue and config.
- Store tasks, runs and transcripts in Postgres, with configured secrets redacted from stored output and comments.
- Read tasks, runs, transcripts, triggers and config from a script or agent with a personal API key.
- Let your own agent sessions read and search tasks, runs and transcripts through a read-only MCP server at `/mcp`.
  The API keys page shows its URL and how to connect an agent to it.

## How it works

```mermaid
flowchart LR
  gitlab[GitLab]

  subgraph host[Host]
    app[Swarmfoundry]
    db[(Postgres)]
    subgraph sandbox[Per run]
      agent[Agent container<br/>Claude Code]
      services[Sidecar services]
    end
  end

  app -->|polls issues and merge requests| gitlab
  app --> db
  app -->|Docker socket| sandbox
  agent -->|clone, push, merge request, labels| gitlab
  agent --> services
```

Swarmfoundry polls GitLab, so it needs no inbound webhook access. It copies prompts, settings and instructions into
each container, starts Claude Code and records its output. Agents use `git` and `glab` as a bot user you create.

The [example config](resources/compose/config/README.md) implements issues labelled `workflow::ready`, sends the merge
request to a separate review agent, and leaves merging to a person.

## Planned features

- Pausing triggers, cancelling runs and re-running failed tasks from the console.
- Triggers on comments that mention the bot, more merge request events and pipeline results.
- Limits on who can fire a trigger and how many times it runs on one issue.
- Better permissions and sandboxing for agents.

## Limitations

- Supports only GitLab issues and Claude Code agents.
- Docker socket access gives the orchestrator root-equivalent access to its host. Use a dedicated host.
- Agents can push to any branch the bot can access. Protect your default branch.

## Install

Follow the [deployment guide](DEPLOYMENT.md) to install and upgrade Swarmfoundry with Docker Compose. Start with the
[example config](resources/compose/config/README.md) to define your triggers.

## AI use

I develop Swarmfoundry with AI assistance, including agents run by Swarmfoundry itself, and review every change.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately, as described in
[SECURITY.md](SECURITY.md).

## Licence

Copyright (C) 2026 Louis Collins

Swarmfoundry is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).

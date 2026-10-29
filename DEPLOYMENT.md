# Deploying Swarmfoundry

Run Swarmfoundry with Docker Compose:

- The **app** polls GitLab, matches triggers and starts agent containers through the host's Docker daemon. It also
  serves the web interface on localhost.
- Compose builds the **agent image** from `config/agent/Dockerfile`. Add your projects' tools to this image.
- **Postgres** stores tasks, runs, transcripts and config revisions.

You need Docker Engine 28 or later with the Compose plugin, a GitLab instance, and a Claude subscription or an
Anthropic API key for the agents.

> **Warning:** Docker socket access gives the app root-equivalent access to the host. Agents run with Claude's
> permission checks off. See the [security recommendations](#security-recommendations) before using it on live projects.

## Install

1. Prepare GitLab:
   - Create a bot user with the Developer role on each watched project. Give it a personal access token with `api`
     and `write_repository` scopes.
   - Create a token for the orchestrator with `api`, such as a project access token with the Reporter role.
   - Create the labels used by your triggers. The example config's README lists the labels it needs.

2. For an `oauth` agent, run `claude setup-token` on a machine with a browser using the account that will pay for agent
   usage. For an `apiKey` agent, use an Anthropic API key.

3. Copy `resources/compose` from your chosen [release](https://github.com/lcollins-dev/swarmfoundry/releases) tag to
   the host. Use the matching release image.

4. Create your config in `config/swarmfoundry.yaml`. An [example config](resources/compose/config/README.md) is
   provided with inline explanations. Keep `config/agent/Dockerfile` and add any tools your agents need.

5. Run `cp .env.tpl .env`, then fill it in:

   | Setting                 | Value                                                                          |
   | ----------------------- | ------------------------------------------------------------------------------ |
   | `SWARMFOUNDRY_VERSION`  | Release version without the `v`, such as `1.2.3`.                              |
   | `DOCKER_GID`            | Docker socket group ID: `stat -c %g /var/run/docker.sock`.                     |
   | `USER_TOKEN_SECRET`     | Session signing secret: generate with `openssl rand -base64 32`.               |
   | Each `${VAR}` in config | Tokens and values referenced by your config. The template lists the example's. |

6. Run `docker compose up -d --build`.

7. Check `docker compose logs app` for `Loaded swarmfoundry.yaml` and `Polling the source`, with no errors.
   If a `${VAR}` is missing, the app stops and names it in the error.

8. Open the web interface at `http://localhost:8080` on the host.

   Sign in as `admin@example.com` with password `changeme`, and set your own email and password on the setup
   screen immediately. Anyone who can reach the web interface can use these credentials until you change them.

9. Test with a small issue that matches a trigger. For the example config, add `workflow::ready` and assign the bot.
   Within a poll interval, look for `Queued task` in the logs. While the agent runs, `docker ps` shows a container
   named `<namespace>-task<id>-run1-step<n>-agent`, where `<n>` is its position in the trigger's `steps`.

## Config from a repository

To load config from a Git repository and track a branch, set these values in `.env`:

- `SWARMFOUNDRY_CONFIG_REPO`: repository URL.
- `SWARMFOUNDRY_CONFIG_BRANCH`: branch to follow.
- `SWARMFOUNDRY_CONFIG_TOKEN`: token with read access.
- `SWARMFOUNDRY_CONFIG_PATH`: config directory within the repository, if not at its root.

Keep `agent/Dockerfile` in the local `config/` directory and secrets in `.env`. Reference secrets as `${VAR}` in the
repository's config. Each task uses the revision it started with.

Changes load within `SWARMFOUNDRY_CONFIG_POLL_INTERVAL`, logging `Loaded config revision <sha>`. Invalid revisions
log `Revision <sha> is invalid` for each error; the app keeps the previous config.

## Upgrading

1. Copy the new release's `resources/compose` files, other than `config/`, over your copy.
2. Set `SWARMFOUNDRY_VERSION` in `.env` to the new version.
3. Run `docker compose pull --ignore-buildable && docker compose up -d --build`.

The app applies database migrations on startup. `docker compose down` preserves data. Adding `-v` deletes the data,
including run history.

## Security recommendations

For deployments working on live projects, we strongly recommend:

- Use a dedicated host. Docker socket access gives Swarmfoundry root-equivalent access to it.
- Protect each project's default branch, allowing only Maintainers to push and merge. Agents can push to any branch
  the bot can access.
- Restrict merges to the config repository's branch to trusted operators. Anyone who can change that config controls
  the agents' images, mounts and prompts.
- Keep `.env` and the config directory writable only by the operator. Run `chmod 600 .env` to restrict access to secrets.
- Set token expiry dates and plan their rotation.

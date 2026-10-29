# Omit the v prefix. Use dev for a locally built image.
SWARMFOUNDRY_VERSION=

# stat -c %g /var/run/docker.sock
DOCKER_GID=

# openssl rand -base64 32
USER_TOKEN_SECRET=

# Orchestrator token: api scope.
GITLAB_TOKEN=

# Bot token: api and write_repository scopes.
GITLAB_BOT_TOKEN=

# claude setup-token
CLAUDE_CODE_OAUTH_TOKEN=

ANTHROPIC_API_KEY=

#SWARMFOUNDRY_CONFIG_DIR=./config

# With repository config, the agent image still builds from the local config directory's agent/Dockerfile.
#SWARMFOUNDRY_CONFIG_REPO=https://gitlab.example.com/group/swarmfoundry-config.git
#SWARMFOUNDRY_CONFIG_BRANCH=main
#SWARMFOUNDRY_CONFIG_PATH=
#SWARMFOUNDRY_CONFIG_POLL_INTERVAL=60s

# read_repository scope.
#SWARMFOUNDRY_CONFIG_TOKEN=

# Must be unique per orchestrator sharing a Docker daemon.
#SANDBOX_NAMESPACE=swarmfoundry

#APP_PORT=8080

# syntax=docker/dockerfile:1

# The image agents run in, which the Compose deployment builds. Add the tools the project's agents need here.
# Any image works that has bash 5 or later, git, jq, setsid and the agent's CLI, a non-root USER with a home it can
# write, a WORKDIR that user can write, and no Claude auth variable set. The example prompts also need glab.
# Debian rather than Alpine, so the tools an agent builds and tests with find glibc.
FROM node:24.20.0-bookworm-slim

ARG TARGETARCH
ARG GLAB_VERSION=1.122.0
ARG GLAB_SHA256_AMD64=ab853b5e4ab83a42f804c1394b108a698601ae0f37411ba8db0a68c2725c69f6
ARG GLAB_SHA256_ARM64=31e171f9fe69b9adfffec9d6e56e1e51a9ca0580c3dbb8fa263f4dcf8dab6772
ARG CLAUDE_CODE_VERSION=2.1.299

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq procps ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
      amd64) glab_sha256="$GLAB_SHA256_AMD64" ;; \
      arm64) glab_sha256="$GLAB_SHA256_ARM64" ;; \
      *) echo "No glab checksum for architecture '$TARGETARCH'" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/glab.deb "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${TARGETARCH}.deb" \
    && echo "$glab_sha256  /tmp/glab.deb" | sha256sum -c - \
    && dpkg -i /tmp/glab.deb \
    && rm /tmp/glab.deb

# The postinstall swaps in the native binary, which npm skips unless allowed. `--version` fails the build without it.
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && claude --version

# RUN apt-get update \
#     && apt-get install -y --no-install-recommends postgresql-client \
#     && rm -rf /var/lib/apt/lists/*

# Claude refuses to run as root. The agent clones into a new folder in the working directory, so its user must own it.
USER node
WORKDIR /home/node

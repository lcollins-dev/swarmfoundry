# syntax=docker/dockerfile:1

# Any image works with bash 5+, git, jq, setsid, the agent's CLI, a non-root USER that can write its home and WORKDIR,
# and no Claude auth variable set. The example prompts also need glab.
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

# The postinstall fetches the native binary.
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && claude --version

# Add your projects' tools here.
# RUN apt-get update \
#     && apt-get install -y --no-install-recommends postgresql-client \
#     && rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /home/node

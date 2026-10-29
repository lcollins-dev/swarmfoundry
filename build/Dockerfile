# syntax=docker/dockerfile:1

## Build container ##
FROM node:22.18.0-alpine AS builder

WORKDIR /build

# The manifests go in before the source, so a source edit leaves the install layer cached.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY libs/dto/package.json ./libs/dto/
COPY e2e/package.json ./e2e/

RUN --mount=type=cache,target=/root/.npm npm ci --workspace apps/api --workspace apps/web --workspace libs/dto --include-workspace-root

COPY tsconfig.json tsconfig.base.json eslint.root.mjs ./
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY libs ./libs

RUN npm run build:libs
RUN npm run build:api

# Last before the web build, so a new version reuses every layer above.
ARG APP_VERSION=0.0.0
ENV VITE_APP_VERSION=${APP_VERSION}

RUN npm run build:web

## Runtime dependencies ##
FROM node:22.18.0-alpine AS deps

WORKDIR /deps

# Only the api's and the libs' manifests, so the install carries nothing the web app or e2e need. `npm ci --workspace`
# with every manifest present still installs the web app's runtime packages. Optional is omitted because typeorm's
# optional peers would otherwise bring typescript, ts-node and swc.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY libs/dto/package.json ./libs/dto/

RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --omit=optional

# The final stage merges apps/api/node_modules into the root, so refuse a nested module that would replace a root one.
RUN mkdir -p apps/api/node_modules && cd apps/api/node_modules && for module in $(ls -d [!@.]* @*/* 2>/dev/null); do \
      if [ -e "/deps/node_modules/$module" ]; then echo "apps/api/node_modules/$module clashes with a root module" >&2; exit 1; fi; \
    done

## Final container ##
FROM node:22.18.0-alpine

ARG APP_VERSION=0.0.0

ENV NODE_ENV=production
ENV VERSION=${APP_VERSION}
ENV WEB_ROOT_PATH=/app/web
ENV SWARMFOUNDRY_CONFIG_CLONE_DIR=/var/lib/swarmfoundry/config-repo

# A volume mounted on the clone directory takes its owner when first mounted, so node can write it.
RUN apk --no-cache add curl git && install -d -o node -g node /var/lib/swarmfoundry/config-repo

USER node
WORKDIR /app

COPY package.json package-lock.json build/migrate.sh ./

COPY --from=builder /build/apps/api/dist ./
COPY --from=builder /build/apps/api/email-templates ./email-templates
COPY --from=builder /build/libs ./libs
COPY --from=builder /build/apps/api/production.env ./

COPY --from=builder /build/apps/web/dist ./web

# npm nests a dependency under apps/api/node_modules when a hoisted package clashes with its version. The clashing
# hoisted ones are dev-only or belong to another workspace, so are not installed and the api's nested modules merge into
# the root.
COPY --from=deps /deps/node_modules ./node_modules
COPY --from=deps /deps/apps/api/node_modules ./node_modules

HEALTHCHECK --start-period=15s CMD curl --fail http://localhost:3000/api/v1/availability || exit 1

EXPOSE 3000

CMD ["node", "main.js"]

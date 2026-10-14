# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./tsconfig.base.json
COPY patches ./patches
COPY vendor ./vendor
COPY packages ./packages
COPY services ./services
COPY apps ./apps
COPY scripts ./scripts

RUN --mount=type=cache,id=du-connector-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm fetch --frozen-lockfile --ignore-scripts --fetch-retries=5
RUN --mount=type=cache,id=du-connector-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --ignore-scripts --prod=false
RUN --network=none --mount=type=cache,id=du-connector-pnpm-store,target=/pnpm/store pnpm run build
RUN --network=none --mount=type=cache,id=du-connector-pnpm-store,target=/pnpm/store \
    node scripts/docker-build-runtime.cjs connector /deploy

FROM ${NODE_IMAGE} AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /deploy/connector/ ./
COPY --chown=node:node scripts/docker-connector-entrypoint.sh /usr/local/bin/connector-entrypoint.sh
RUN chmod 0555 /usr/local/bin/connector-entrypoint.sh
USER node
STOPSIGNAL SIGTERM
EXPOSE 8080
ENTRYPOINT ["/bin/sh", "/usr/local/bin/connector-entrypoint.sh"]
CMD ["server"]

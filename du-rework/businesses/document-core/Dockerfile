# Build with this directory as the context: docker build -t document-core .
ARG NODE_IMAGE=node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY patches ./patches
COPY vendor ./vendor
RUN --mount=type=cache,id=document-core-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile --ignore-scripts

COPY src ./src
COPY scripts/build.cjs ./scripts/build.cjs
COPY tsconfig.json ./tsconfig.json
RUN pnpm run build
RUN pnpm --filter @du/document-core deploy --prod --legacy /deploy

FROM ${NODE_IMAGE} AS document-core
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /deploy/ ./
USER node
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]

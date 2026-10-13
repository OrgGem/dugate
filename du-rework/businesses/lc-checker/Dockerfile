# Build from this directory: docker build -t du-lc-checker:1.1.0 .
ARG NODE_IMAGE=node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./
COPY vendor ./vendor
COPY src ./src
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm run build
RUN pnpm --filter @du/lc-checker deploy --prod --legacy /deploy

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node
STOPSIGNAL SIGTERM
COPY --from=build --chown=node:node /deploy/ ./
CMD ["node", "dist/main.js"]

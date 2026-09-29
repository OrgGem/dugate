FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY services/connector ./services/connector

RUN --mount=type=cache,id=du-corepack,target=/root/.cache/node/corepack \
  --mount=type=cache,id=du-pnpm-store,target=/root/.local/share/pnpm/store \
  corepack enable \
  && corepack prepare pnpm@10.18.3 --activate \
  && pnpm install --frozen-lockfile --filter @du/connector... --prod=false --fetch-retries=5 \
  && pnpm --filter @du/contracts build \
  && pnpm --filter @du/observability build \
  && pnpm --filter @du/egress build \
  && pnpm --filter @du/connector build

WORKDIR /app/services/connector
RUN mkdir -p ./dist/db/migrations \
  && cp ./src/db/migrations/*.sql ./dist/db/migrations/
RUN chmod +x ./entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["./entrypoint.sh"]

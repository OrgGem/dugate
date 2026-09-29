FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY businesses/document-core ./businesses/document-core

RUN --mount=type=cache,id=du-corepack,target=/root/.cache/node/corepack \
  --mount=type=cache,id=du-pnpm-store,target=/root/.local/share/pnpm/store \
  corepack enable \
  && corepack prepare pnpm@10.18.3 --activate \
  && pnpm install --frozen-lockfile --filter @du/document-core... --prod=false --fetch-retries=5 \
  && pnpm --filter @du/contracts build \
  && pnpm --filter @du/observability build \
  && pnpm --filter @du/egress build \
  && pnpm --filter @du/document-kit build \
  && pnpm --filter @du/worker-sdk build \
  && pnpm --filter @du/document-core build

WORKDIR /app/businesses/document-core

CMD ["node", "dist/main.js"]

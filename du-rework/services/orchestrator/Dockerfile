FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc* ./
COPY packages ./packages
COPY services/orchestrator ./services/orchestrator
COPY services/connector/package.json ./services/connector/package.json
COPY businesses/document-core/package.json ./businesses/document-core/package.json
COPY businesses/example-review/package.json ./businesses/example-review/package.json
COPY tests/integration/package.json ./tests/integration/package.json

RUN corepack enable \
  && pnpm install --frozen-lockfile --filter @du/orchestrator... \
  && pnpm --filter @du/orchestrator build

WORKDIR /app/services/orchestrator
EXPOSE 3000
CMD ["node", "dist/main.js"]

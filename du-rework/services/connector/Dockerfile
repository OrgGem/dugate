FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages ./packages
COPY services/connector ./services/connector
COPY services/orchestrator/package.json ./services/orchestrator/package.json
COPY businesses/document-core/package.json ./businesses/document-core/package.json
COPY businesses/example-review/package.json ./businesses/example-review/package.json
COPY tests/integration/package.json ./tests/integration/package.json

RUN corepack enable \
  && pnpm install --frozen-lockfile --filter @du/connector... \
  && pnpm --filter @du/connector build

WORKDIR /app/services/connector
RUN mkdir -p ./dist/db/migrations \
  && cp ./src/db/migrations/*.sql ./dist/db/migrations/
RUN chmod +x ./entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["./entrypoint.sh"]

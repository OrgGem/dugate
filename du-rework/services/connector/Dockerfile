FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY services/connector ./services/connector

RUN corepack enable \
  && pnpm install --frozen-lockfile --filter @du/connector... \
  && pnpm --filter @du/connector build

WORKDIR /app/services/connector
RUN mkdir -p ./dist/db/migrations \
  && cp ./src/db/migrations/001_connector.sql ./dist/db/migrations/001_connector.sql
RUN chmod +x ./entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["./entrypoint.sh"]

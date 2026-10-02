FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY businesses/lc-checker ./businesses/lc-checker
COPY services/connector/package.json ./services/connector/package.json
COPY services/orchestrator/package.json ./services/orchestrator/package.json
COPY businesses/document-core/package.json ./businesses/document-core/package.json
COPY tests/integration/package.json ./tests/integration/package.json

# Clean any host artifacts to guarantee a self-contained reproducible build
RUN rm -rf packages/*/dist packages/*/node_modules businesses/*/dist businesses/*/node_modules \
  && corepack enable \
  && corepack prepare pnpm@10.18.3 --activate \
  && pnpm config set ignore-scripts true \
  && pnpm install --frozen-lockfile --filter @du/lc-checker... \
  && pnpm --filter @du/lc-checker... build

WORKDIR /app/businesses/lc-checker
RUN chmod +x ./entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]

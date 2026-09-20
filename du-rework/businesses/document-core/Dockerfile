FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY businesses/document-core ./businesses/document-core

RUN corepack enable \
  && pnpm install --frozen-lockfile --filter @du/document-core... \
  && pnpm --filter @du/document-core build

WORKDIR /app/businesses/document-core

CMD ["node", "dist/main.js"]

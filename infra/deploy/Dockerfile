# One image for the API, the worker, the migrations and the admin web app (the compose file picks the command).
FROM node:22-bookworm-slim
ENV CI=1 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @timekeeper/api... --filter @timekeeper/web... \
 && pnpm --filter @timekeeper/domain build \
 && pnpm --filter @timekeeper/api build \
 && pnpm --filter @timekeeper/web build
ENV NODE_ENV=production
USER node

# syntax=docker/dockerfile:1
# Образ @tg/api. Контекст сборки — корень монорепо:
#   docker build -f apps/api/Dockerfile -t tourist-guide-api .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true SKIP_INSTALL_SIMPLE_GIT_HOOKS=1
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@tg/api...
# Отдельное дерево только с prod-зависимостями; workspace-пакеты копируются по полю "files" (dist).
RUN pnpm --filter=@tg/api deploy --prod /out

FROM node:${NODE_VERSION}-alpine AS runtime
# tini — PID 1: пробрасывает SIGTERM/SIGINT в node (graceful shutdown) и собирает зомби-процессы.
# Версия не закреплена: она определяется релизом Alpine базового образа (закрепить вместе с digest образа).
RUN apk add --no-cache tini
ENV NODE_ENV=production
ENV PORT=4300
EXPOSE 4300
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# Миграции (apps/api/migrations попадают в образ по полю "files"): шаг перед стартом новой версии —
#   docker run --rm -e DATABASE_URL=... tourist-guide-api node dist/db/migrate-cli.js
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

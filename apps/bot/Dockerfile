# syntax=docker/dockerfile:1
# Образ @tg/bot. Контекст сборки — корень монорепо:
#   docker build -f apps/bot/Dockerfile -t tourist-guide-bot .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true SKIP_INSTALL_SIMPLE_GIT_HOOKS=1
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@tg/bot...
# Отдельное дерево только с prod-зависимостями; workspace-пакеты копируются по полю "files" (dist).
RUN pnpm --filter=@tg/bot deploy --prod /out

FROM node:${NODE_VERSION}-alpine AS runtime
# tini — PID 1: пробрасывает SIGTERM/SIGINT в node (graceful shutdown) и собирает зомби-процессы.
# Версия не закреплена: она определяется релизом Alpine базового образа (закрепить вместе с digest образа).
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

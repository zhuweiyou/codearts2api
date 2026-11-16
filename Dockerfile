# syntax=docker/dockerfile:1

# 构建阶段：装依赖 + 构建前端(dist/) 与后端(dist-server/)
FROM node:24-slim AS build
WORKDIR /app
# git 用于拉取 git 依赖；ca-certificates 用于 TLS
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# 运行阶段：仅带运行所需产物与依赖
FROM node:24-slim AS runtime
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
ENV CODEARTS2API_HOME=/data
ENV PORT=8080
ENV PROXY_GATEWAY=1
ENV DSH_OPENAI_GATEWAY_PORT=8326
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "dist-server/index.js"]

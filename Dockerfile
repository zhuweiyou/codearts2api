# syntax=docker/dockerfile:1

# ── 构建阶段：装依赖（含 dev）→ 构建 dist/ 与 dist-server/ → 剪掉 dev 依赖 ──
FROM node:24-slim AS build
WORKDIR /app

# git：pnpm 要克隆 git 依赖；ca-certificates：TLS 校验
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 显式钉 pnpm 版本：corepack 的默认版本会随 Node 镜像漂移，构建不可复现
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

# 先只拷清单，让依赖层能被缓存。pnpm-workspace.yaml 里的 overrides / allowBuilds
# 会影响解析与 prepare，必须一起进镜像。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 必须用环境变量：只有它能穿透到 pnpm 的子进程，
# 绕过 pnpm 11 的「新包冷却期」（上游会把刚发布的 dsh-* 写进自己的 lock）。
# 缓存挂载只加速重装，不进镜像层。
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# 剪掉 devDependencies：运行期只需要 express / @deepseek-ai/* / dsh-providers-hub。
# 不 prune 的话 vite-plus、typescript、jsdom 等都会被打进运行镜像。
RUN pnpm prune --prod

# ── 运行阶段：只带运行产物与运行期依赖 ──
FROM node:24-slim AS runtime
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

ENV NODE_ENV=production
# 本程序自己的状态目录（账号池、凭据、网关 Key、管理密钥），挂卷持久化
ENV CODEARTS2API_HOME=/data
ENV PORT=8080
# 上游网关的监听地址硬编码为 127.0.0.1，容器外无法直达，因此由本服务反代 /v1/*
ENV PROXY_GATEWAY=1
ENV DSH_OPENAI_GATEWAY_PORT=8326

VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "dist-server/index.js"]

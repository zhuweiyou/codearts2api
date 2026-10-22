# syntax=docker/dockerfile:1

# 基础镜像要满足两个条件：
# 1. Node ≥ 22.19（上游 `engines` 的下限，也是 `AbortSignal.any` 等 API 的前提）；
# 2. 带 pnpm —— git 依赖的 `prepare` 脚本会执行 `pnpm build:all`。
#
# ⚠️ **为什么是 24 而不是 22**（2026-10-21 换）：Node 22 已于 2026-10-20 转入
#    Maintenance LTS，**2027-04-30 EOL**（只剩半年多）；Node 24 的 EOL 是 2028-04-30。
#    上游与本仓库的 `engines` 都是 `^22.19.0 || >=24.0.0`，24 完全满足。
#    26 要到 2026-10-28 才转 Active LTS（EOL 2029-04-30），届时可再升。
FROM node:24-slim

# git：npm 要从 GitHub 克隆依赖；ca-certificates：TLS 根证书。
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ── pnpm：显式钉版本 ──
# 上游的 `prepare` 是 `pnpm build:all`，所以装依赖时**必须**有 pnpm 可用。
#
# ⚠️ 上游 2026-10-21 的 b0940ca 之后 `prepare` 已改成内联真实命令、不再依赖任何
#    包管理器。但**本仓库锁定的 commit 可能还没到那一步**（升级是逐个 commit 走的），
#    所以这里**继续保留 pnpm** —— 留着无害，去掉则会在旧 commit 上装不上。
#
# ⚠️ 不用裸 `corepack enable`：那会让 corepack 用**它自己内置的默认版本**，
#    该默认值随 Node 镜像版本漂移（本仓库开发机上实测拿到 11.25.0，但别的
#    Node 小版本可能不同），构建因此不可复现。这里显式 `prepare --activate`
#    钉住版本，与开发机一致。
#
# ⚠️ 也不在 package.json 里写 `packageManager` 字段：npm 10+ 见到该字段指向
#    非 npm 的包管理器时会**拒绝执行 `npm install`**（提示本项目配置用 pnpm），
#    而本项目的安装走的就是 npm。故只在镜像里钉 pnpm。
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate \
  && pnpm --version

WORKDIR /app

# ── 依赖层：先只拷清单，让这一层能被缓存 ──
# ⚠️ 这里必须装到 devDependencies（默认行为，**不要**加 `--omit=dev`）：
#    前端 `public/admin.js` 由 esbuild + react 在镜像构建期产出，
#    而 `npm run build` 需要 esbuild 的二进制与 react 的源码作为**输入**。
#    （产出物自带 React 运行时，运行期**不需要** react —— 见 README。）
#
# ⚠️ 显式 `--include=dev` 不是多余的：若构建环境带着 `NODE_ENV=production`
#    （CI/平台常这么设），npm 会**默认跳过** devDependencies，于是 esbuild 与
#    react 装不上、`npm run build` 直接失败。显式写出来让这一层对
#    `NODE_ENV` 免疫（已实测：production 下不加这个参数就装不到 esbuild）。
#
# ⚠️ 上游插件同样是运行期依赖，它的 prepare 要跑 tsc。
#
# 💡 `sharp`（附件服务用来校验/缩放图片）是**原生包**，靠 optionalDependencies
#    分发平台二进制。lockfile 里已含 linux-x64 / linuxmusl-x64 等全部平台条目，
#    故 Debian 基底能直接装上，不需要额外 apt 依赖（预编译包自带 libvips）。
#
# ⚠️ `PNPM_CONFIG_MINIMUM_RELEASE_AGE=0` **不能删**：pnpm 11 有「新包冷却期」
#    （默认拒绝装上发布不足 24 小时的包），而上游会把它**刚发布**的 DSH 基础包
#    （`@deepseek-ai/dsh-*`）写进自己的 `pnpm-lock.yaml`，于是 prepare 直接失败：
#    `The lockfile contains entries that the active policies reject …`。
#    ⚠️ 只有这个**环境变量**能穿透到 npm 拉起的 pnpm 子进程 —— `.npmrc` 与
#    `npm_config_*` 均已实测无效。删掉这行，镜像会在上游每次发版后约 24 小时内
#    构建失败。详见 README「快速开始」的同名提示。
COPY package.json package-lock.json* ./
RUN PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 npm install --include=dev --no-audit --no-fund

# ── 源码与前端构建 ──
COPY . .
# public/admin.js 是构建产物，不入库；每次镜像构建都重生成，
# 保证前端与所锁定的上游 commit 一致。
RUN npm run build

# ── 运行 ──
# 本程序自己的状态目录（账号池、凭据、网关 API Key、管理密钥都在这下面），
# 挂卷即可持久化；不挂则容器重启后账号会丢。
# ⚠️ 用 CODEARTS2API_HOME 而不是 DSH_HOME：后者是 DSH 的变量，本程序启动时
#    会把它覆盖成自己的目录，写在这里容易误导（也不生效）。
ENV CODEARTS2API_HOME=/data
ENV PORT=8080
# 插件网关的**监听地址**被上游硬编码为 127.0.0.1（不可经 env 改），所以容器外
# 无法直达它 —— 必须让本服务把 /v1/* 转发进来，对外只需一个端口。
#
# ⚠️ 这行现在是**冗余**的：产品默认已开启（见 src/index.js 的 resolveProxyGateway）。
#    保留它是为了「将来默认值再变时，镜像行为不跟着漂」。
ENV PROXY_GATEWAY=1
# 管理端鉴权默认开启：独立于网关 Key 的管理密钥会自动生成到 /data/admin-key。
# ⚠️ 这里**刻意不设** CODEARTS2API_ADMIN_KEY —— 让每个部署实例各自随机生成。
#    若写死一个值，所有用这个镜像的人就共用同一把后台密码。
#    需要固定值时由使用者自己 `-e CODEARTS2API_ADMIN_KEY=...` 覆盖。
# 网关仍是本机回环上的独立端口（由插件自己监听），仅容器内部使用。
ENV DSH_OPENAI_GATEWAY_PORT=8326

VOLUME ["/data"]
# 8080：管理界面 /admin（带登录页）与 OpenAI 兼容接口 /v1/*。
# 8326 不需要对外暴露。
EXPOSE 8080

CMD ["node", "src/index.js"]

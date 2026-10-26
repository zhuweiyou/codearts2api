# codearts2api

把 [`dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub) 的
**Jet Hub 多渠道账号管理**与**本机 OpenAI 网关**搬到独立后端运行，**不依赖 DSH 宿主**，
面向自建服务与容器部署。

它不 fork 上游代码，而是直接把上游的插件装载起来 —— 所以**渠道、模型、协议、界面
都跟着上游走**，本项目自己只负责鉴权、状态隔离与对外接口。

<img width="1920" height="1031" alt="Jet Hub 管理界面（上游设置页原样复用）" src="https://github.com/user-attachments/assets/0fc7e323-2830-49e0-898f-88e28c631a71" />

## 目录

**使用**

- [特性](#特性)
- [快速开始](#快速开始)
- [配置](#配置)
  - [环境变量](#环境变量)
  - [状态目录](#状态目录)
  - [从 DSH 或旧版本迁移账号](#从-dsh-或旧版本迁移账号)
- [使用](#使用)
  - [管理端鉴权](#管理端鉴权)
  - [管理界面](#管理界面)
  - [OpenAI 兼容接口](#openai-兼容接口)
  - [聚合路由](#聚合路由)
- [部署](#部署)
  - [本机直跑](#本机直跑)
  - [Docker](#docker)
  - [反向代理](#反向代理现在只为-tls--限流不为鉴权)
- [安全边界](#安全边界)
- [常见问题](#常见问题)
  - [远程部署的登录隧道](#远程部署的登录隧道)
  - [出不去墙外服务（Gemini / 出口代理）](#出不去墙外服务gemini--出口代理)
  - [图片输入](#图片输入)
  - [已知边界](#已知边界)

**开发**

- [架构](#架构)
- [开发](#开发)
  - [自动升级（GitHub Actions）](#自动升级github-actions)
- [变更记录与升级](#变更记录与升级)

## 特性

- **多渠道账号管理**：`/admin` 原样复用上游 Jet Hub 设置页 —— 各渠道的增删改查、
  账号池、额度与限流、模型级 / 渠道级开关、聚合路由面板、备份与迁移。
- **OpenAI 兼容网关**：`/v1/models`、`/v1/chat/completions`、`/v1/responses`，
  支持 SSE 流式、图片输入与 token 用量统计。
- **两条聚合路由**：`aggregate/*` 把同一模型的跨渠道候选归一化后按额度临期选号并
  失败切换；`jet-hub-auto/auto` 自动选渠道与模型。
- **状态隔离**：账号、凭据、网关密钥与管理密钥全在本程序自己的目录（默认 `~/.codearts2api`），
  **不读写** `~/.dsh`，可与 DSH 共存。
- **自带管理端鉴权**：公网部署不需要 nginx Basic Auth —— 首次启动生成管理密钥，`/admin`
  带登录页、会话 Cookie 与登录限速，且密钥与网关 Key 刻意分开（发出去的 Key 进不了后台）。
- **上游持续更新**：渠道、模型、协议跟着上游走，本项目不 fork、不改上游代码。

提供的 HTTP 接口：

| 路径                                                                | 说明                                               |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| `GET /admin`                                                        | 管理界面（登录页 → 上游 Jet Hub 设置页）           |
| `POST /api/jet-hub`                                                 | Jet Hub 管理 RPC（上游实现的原样透传，需管理密钥） |
| `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses` | OpenAI 兼容接口（上游网关，需网关 Key）            |
| `GET /healthz`                                                      | 健康检查（不含密钥，可给监控用）                   |

> 📋 历次变更见 [`CHANGELOG.md`](CHANGELOG.md)。

## 快速开始

**要求**：Node.js `^22.19.0 || >=24.0.0`（**建议用 24 或更高**），且 `pnpm` 在 `PATH` 上。

> 💡 **用 Node 24+ 更省事**：只有 Node 24+ 才带 `NODE_USE_ENV_PROXY`，
> 需要让程序走系统代理时（出墙场景）不必再单独给账号配代理，
> 见[出不去墙外服务](#出不去墙外服务gemini--出口代理)。

```bash
npm install          # 需要 pnpm，见下方说明
npm run build        # 生成 public/admin.js 与 public/upstream-jet-hub.js
npm start            # 默认 http://127.0.0.1:8080/admin
```

打开 <http://127.0.0.1:8080/admin> 即可看到与 DSH 里一致的 Jet Hub 界面。

> ⚠️ `npm install` 会从 GitHub 拉取上游并执行它的 `prepare`（`tsc` + 两个 node 脚本，
> 现场编译 `lib/`），因为上游的 `lib/` **不入库**、必须现场编译。
> 早先的版本 `prepare` 是 `pnpm build:all`、需要本机有 pnpm；上游已改为不依赖任何
> 包管理器，所以**现在不再需要预装 pnpm**。若在旧 commit 上安装，仍需
> `corepack enable` 或 `npm i -g pnpm`。

> ⚠️ **pnpm 11 的「新包冷却期」会让上游发布后 24 小时内的安装失败。**
> pnpm 11 默认拒绝装上「发布不足 24 小时」的包，而上游会把它刚发布的 DSH 基础包
> （`@deepseek-ai/dsh-*`）写进**自己的** `pnpm-lock.yaml` —— npm 在克隆目录里跑
> `prepare` 时就会撞上，报：
>
> ```
> The lockfile contains entries that the active policies reject.
> @deepseek-ai/dsh-llm@0.2.1-rc.2 was published at …, within the minimumReleaseAge cutoff
> ```
>
> 放行办法（**只有环境变量能穿透**，`.npmrc` 里写 `minimum-release-age` 无效、
> `npm_config_*` 也无效）：
>
> ```bash
> PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 npm install --include=dev
> ```
>
> 这是**限时**问题：等那批包发布满 24 小时，裸 `npm install` 就会自动恢复正常。

## 配置

### 环境变量

| 变量                         | 默认              | 说明                                                                              |
| ---------------------------- | ----------------- | --------------------------------------------------------------------------------- |
| `CODEARTS2API_HOME`          | `~/.codearts2api` | **本程序自己的状态目录**：账号池、凭据、网关 Key、管理密钥全在这里                |
| `PORT`                       | `8080`            | 本服务端口（管理界面 + RPC + 反代）                                               |
| `HOST`                       | `0.0.0.0`         | 监听地址                                                                          |
| `PROXY_GATEWAY`              | **开**            | 把 `/v1/*` 反代到插件网关；置 `0/false/off/no` 关闭（直连 `8326` 仍可用）         |
| `CODEARTS2API_ADMIN_KEY`     | 自动生成          | **管理后台访问密钥**（与网关 Key 是两把，见[管理端鉴权](#管理端鉴权)）            |
| `CODEARTS2API_ADMIN_AUTH`    | **开**            | 置 `0` **关闭**管理端鉴权（仅限本机；启动日志会显著告警）                         |
| `DSH_OPENAI_GATEWAY_PORT`    | `8326`            | 插件网关端口（只绑 `127.0.0.1`，见下）                                            |
| `DSH_OPENAI_GATEWAY_ENABLED` | `1`               | 置 `0/false/off/no` 则**强制停用**网关（面板开关会显示被 env 阻止，且无法再打开） |
| `DSH_OPENAI_GATEWAY_API_KEY` | 自动生成          | 网关 Bearer Key，优先于文件                                                       |
| `LOG_LEVEL`                  | `info`            | `silent` / `error` / `info` / `debug`                                             |

### 状态目录

状态全放在自己的目录（默认 `~/.codearts2api`），**不读写** `~/.dsh`，可以与 DSH 共存。

### 从 DSH 或旧版本迁移账号

新版本用的是空目录，第一次跑看不到原有账号。两种搬法：

**方式 A：直接拷文件（推荐）** —— 存储格式与 DSH **完全一致**
（`jet-hub/state.json` + `.credentials.yaml`），直接拷两个文件即可：

```bash
mkdir -p ~/.codearts2api/jet-hub
cp ~/.dsh/jet-hub/state.json       ~/.codearts2api/jet-hub/state.json
cp ~/.dsh/.credentials.yaml        ~/.codearts2api/.credentials.yaml
chmod 600 ~/.codearts2api/.credentials.yaml      # 权限校验要求，否则启动即报错
```

> ⚠️ 别整目录拷：`~/.dsh` 里还有 DSH 自己的缓存与 records 段，只需上面两个文件。

**方式 B：走界面备份** —— `/admin` 的「备份」导出 → 目标实例「恢复」导入
（自包含 JSON，凭据一并带走）。导入模式的区别见[远程部署的登录隧道](#远程部署的登录隧道)。

> ⚠️ 无论哪种，**不要再让两个程序共用同一个目录**：它们对同一份状态各有假设，
> 互相覆盖时很难排查。

## 使用

### 管理端鉴权

公网部署不需要再配 nginx 做访问控制，服务自带登录页。

首次启动会自动生成一把管理密钥到 `<CODEARTS2API_HOME>/admin-key`（权限 `0600`），
并**只在生成那一次**打印到日志：

```
[admin-auth] 已生成管理密钥（仅本次打印，之后请查看文件）：jUZPr--cyFPM65Zrwu13hXAjECu4HsqFWcGAcvtTejQ
[admin-auth] 密钥文件：/data/admin-key
```

打开 `/admin` 会先看到登录页，粘贴这把密钥即可。登录态存成 **HttpOnly 会话 Cookie**，
30 天有效，之后不用反复输入。

> ⚠️ **管理密钥与网关 Key 是两把，不要混用。**
>
> | 密钥                                     | 位置                            | 给谁                       | 权限                             |
> | ---------------------------------------- | ------------------------------- | -------------------------- | -------------------------------- |
> | **管理密钥**（`admin-key`）              | `<home>/admin-key`              | **只有你自己**             | 进后台、改配置、导出全部账号凭据 |
> | **网关 Key**（`openai-gateway/api-key`） | `<home>/openai-gateway/api-key` | **调用方**（客户端、朋友） | 只能调 `/v1/*` 推理接口          |
>
> 管理密钥能导出全部账号凭据，网关 Key 只能调推理接口。两把分开，才能放心把
> 网关 Key 发给别人。

**脚本 / curl**：带 `Authorization: Bearer <admin-key>` 即可，不需要走登录页：

```bash
KEY=$(cat ~/.codearts2api/admin-key)
curl -s -X POST http://127.0.0.1:8080/api/jet-hub \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"1","method":"jet-hub","payload":{"method":"gateway.getEnabled","payload":{}}}'
```

**放行清单**（不需要密钥的三条路径，都是刻意的）：

| 路径                           | 为什么放行                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `/healthz`                     | 不含密钥（只有开关、地址、模型数），要给监控 / 容器探活                                                                          |
| `/v1/*`                        | 它有自己的 Bearer 校验，判定权只在一处                                                                                           |
| `/api/jet-hub/captcha-carrier` | 验证码载体页：页面里只有阿里云 SDK 的公开参数，且要被 `<webview>` 直接导航（那类导航带不了任何头）—— 加鉴权会直接废掉 zcode 渠道 |

其余**一律拦截**。

**忘记密钥**：删掉 `<home>/admin-key` 重启即可重新生成（届时需重新登录）；
或用 `CODEARTS2API_ADMIN_KEY` 环境变量指定。

**关闭登录**（仅限本机）：`CODEARTS2API_ADMIN_AUTH=0`。启动日志会打一条醒目告警，
`/healthz` 也会回显 `adminAuth: false`，便于运维发现。

#### 关于 TLS

服务自身只提供**明文 HTTP**，鉴权解决的是「谁能进后台」，不解决「链路上谁看得见」。
公网部署仍建议二者之一：

1. 反代只做 TLS 终结（**不参与鉴权**，鉴权已由本服务完成）：
   ```nginx
   location / {
     proxy_pass http://127.0.0.1:8080;
   }
   ```
2. 或直接用 **Cloudflare Tunnel / Tailscale** 这类隧道（不用自己签证书）。

> 会话 Cookie 的 `Secure` 标志只在服务自身以 HTTPS 启动时才加。这样按
> `http://ip:8080` 直连时 Cookie 一定存得下，不会出现「密钥输对了却一直要求重新登录」。

### 管理界面

打开 `/admin`（登录后）。左侧导航为**各渠道 + 1 个「聚合 (跨渠道)」面板**，页头「网关」按钮
可查看监听地址、复制 API Key 与模型清单。

账号卡片上的按钮随渠道而变：**测试 / 重测 / 重置 / 停用 / 删除** 是通用的；
「**代理**」只对 `opencode` 与 `gemini` 出现（两者是**两份独立配置**，见
[出不去墙外服务](#出不去墙外服务gemini--出口代理)）；「**指纹**」只对 `opencode` 出现。

### OpenAI 兼容接口

先拿到网关地址与密钥：登录 `/admin` → 页头 **「网关」** 按钮 → 显示实际监听地址、
可复制 API Key、模型清单。

客户端把 `base_url` 指向网关、`api_key` 填那个 Key 即可。模型 ID 形如
`provider/模型名`（如 `codearts/deepseek-v4.1-flash`、`opencode/big-pickle`），
**必须带渠道前缀**；可用模型以 `GET /v1/models` 返回为准。

### 聚合路由

除各渠道自己的模型外，上游还提供两条聚合路由：

| 路由                     | 行为                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `aggregate/<规范模型名>` | 把同一模型在各渠道的条目归一化，按额度临期顺序选号，失败时切换下一个候选 |
| `jet-hub-auto/auto`      | 在候选渠道中自动挑选可用者与模型                                         |

`/admin` 的「聚合 (跨渠道)」面板可查看候选并设置是否参与轮换。两条路由都需要先配置好
对应渠道的账号，否则目录为空。

## 部署

### 本机直跑

```bash
PORT=8080 CODEARTS2API_HOME=/var/lib/codearts2api node src/index.js
```

一个端口同时提供 `/admin`（带登录页）与 `/v1/*`（反代默认已开）。首次启动会在日志里
打印一次管理密钥。

> 只想本机随便看看、不想每次输密钥：加 `CODEARTS2API_ADMIN_AUTH=0`。
> **绝不要**在公网可达的机器上这么设。

### Docker

```bash
docker build -t codearts2api .
docker run -d --name codearts2api \
  -p 8080:8080 \
  -v codearts2api-data:/data \
  codearts2api
```

`CODEARTS2API_HOME=/data` 已由镜像设好并声明为 `VOLUME`；**不挂卷则容器重建后账号会丢**。

> ✅ **管理接口自带鉴权**，`-p 8080:8080` 不会把后台暴露给公网。
> 首次启动自动生成管理密钥到 `/data/admin-key`，打开 `/admin` 用登录页进入即可，
> **不需要**配 nginx Basic Auth / OAuth / IP 白名单。详见[管理端鉴权](#管理端鉴权)。
> 仍需自行解决 TLS（见下），否则密钥与对话内容在链路上是明文。

查看自动生成的管理密钥：

```bash
docker exec codearts2api cat /data/admin-key
```

> 想固定一把（比如写进密码管理器）就加 `-e CODEARTS2API_ADMIN_KEY=你的密钥`，
> 此后不再生成文件。⚠️ 别把它写进公开的 compose / 脚本里。

#### GHCR 预构建镜像

仓库启用 GitHub Actions 后，`Publish image` 工作流会发布 `linux/amd64` 与
`linux/arm64` 镜像到
[`ghcr.io/zhuweiyou/codearts2api`](https://github.com/zhuweiyou/codearts2api/pkgs/container/codearts2api)
（仓库路径自动转为小写，fork 无需改配置）。各标签、各架构的拉取命令也可以直接在
上面那个包页面的 **Installation** 标签页里复制。

```bash
# 拉取最新镜像（latest 始终跟随默认分支的最新一次成功发布）
docker pull ghcr.io/zhuweiyou/codearts2api:latest

docker run -d --name codearts2api \
  -p 8080:8080 \
  -v codearts2api-data:/data \
  ghcr.io/zhuweiyou/codearts2api:latest
```

| 触发方式                    | 镜像标签与行为                                               |
| --------------------------- | ------------------------------------------------------------ |
| 推送到默认分支              | 发布 `latest` 与 `sha-<完整提交 SHA>`                        |
| 推送版本标签（如 `v1.2.3`） | 发布 `1.2.3`、`1.2` 与 SHA 标签；`latest` 始终跟随默认分支   |
| Pull request                | 构建两种架构以验证 Dockerfile，不登录 GHCR、不发布镜像       |
| Actions 页手动运行          | 发布所选分支或标签的 SHA 镜像；选默认分支时同时更新 `latest` |
| 自动升级依赖并成功推送      | 直接复用发布流程，构建升级后的提交；无更新或升级失败则跳过   |

发布使用内置 `GITHUB_TOKEN`，无需额外 Secret。首次发布后，如需匿名拉取，
在仓库的 **Packages → 镜像包 → Package settings** 中将可见性设为 **Public**。

#### `PROXY_GATEWAY` 默认开启

插件网关的监听地址在上游是**硬编码**的 `127.0.0.1`（`DEFAULT_GATEWAY_HOST` 不可经环境
变量修改 —— 那是上游刻意的安全边界，避免被误暴露成公网服务）。所以容器外**无法**直接
访问 `8326`。本服务因此**默认**把 `/v1/*` 透明转发到回环上的网关，对外只需暴露 8080。

需要关闭时设 `PROXY_GATEWAY=0`（网关照旧监听 8326，仍可直连）。

反代**不碰 `Authorization`**：客户端仍须带网关的 Bearer Key，鉴权判定权始终只在插件
网关一处，不存在两套鉴权。

### 反向代理（现在只为 TLS / 限流，不为鉴权）

```nginx
server {
  listen 443 ssl;
  server_name your-host;

  # 管理界面：**不需要**再加 Basic Auth —— 本服务自己有登录页
  location / {
    proxy_pass http://127.0.0.1:8080;
  }

  # OpenAI 兼容接口：流式，必须关闭缓冲
  location /v1/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_buffering off;          # 否则 SSE 被攒起来再吐，客户端会超时
    proxy_read_timeout 600s;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
  }
}
```

> 反代挂在前面时，登录限速会按反代自己的地址统一计算（因为服务只认 TCP 对端地址），
> 粒度会变粗。

## 安全边界

1. **管理端受管理密钥保护**（`/admin`、静态子资源、`/api/jet-hub`）。它能看到并操作
   你的全部账号凭据，也会**明文回传网关 API Key** —— 所以密钥务必当作密码保管，
   不要写进公开的 compose 文件或截图。
   - 密钥在 `<CODEARTS2API_HOME>/admin-key`（`0600`）或 `CODEARTS2API_ADMIN_KEY`；
   - 浏览器侧用 **HttpOnly 会话 Cookie**（XSS 拿不到），令牌是派生值、不是明文密钥 ——
     拿到 Cookie 也推不回密钥；
   - 登录失败按来源 IP 限速（10 次 / 10 分钟）；
   - 想关闭登录（**仅限本机**）：`CODEARTS2API_ADMIN_AUTH=0`，启动日志会告警。
2. **网关密钥**以明文存在 `<CODEARTS2API_HOME>/openai-gateway/api-key`（`0600`）。
   文件被改坏时上游会**明确报错**而不是悄悄换一个 —— 因为静默换钥会让所有已配置的
   客户端同时 401。恢复办法：删掉该文件重启（会重建），或改用
   `DSH_OPENAI_GATEWAY_API_KEY` 环境变量。
   > 这把是**发给调用方**的，与上面的管理密钥刻意分开 —— 否则你把网关 Key 给朋友，
   > 朋友就同时拿到了后台权限。
3. **`/healthz` 刻意不含密钥**（只回开关、地址、模型数），可以安全地给监控用。
4. **TLS 不在本服务范围内**：鉴权解决「谁能进」，不解决「链路上谁看得见」。
   公网部署请让反代终结 TLS，或用 Cloudflare Tunnel / Tailscale 这类隧道。

## 常见问题

### 远程部署的登录隧道

上游所有**回调式**登录（CodeArts / LobsterAI / TRAE / Loomy / Raccoon）都硬编码绑
`127.0.0.1`、端口随机且 ≥10000。所以在**远程服务器**上部署时，浏览器授权后的回调打到
的是**你本机**、不是服务器 —— 服务器会一直等不到回调。

**工作流**：① `/admin` 点「+ 新建账号」，从返回的 `loginUrl` 读出端口（形如
`...:19283/...`）；② **在本机**建隧道
`ssh -L 19283:127.0.0.1:19283 user@your-server`；③ 打开那个 `loginUrl` 完成授权。

**无需隧道**的渠道：`qoder` / `qodercn` / `cline`（设备码轮询）、`opencode`
（可直接粘贴 `sk-` key）、`astudio`（导入本机桌面端会话，见下）。

#### AStudio 的特殊之处：登录靠**导入本机会话**，不是 OAuth

`astudio`（讯飞 astronautStudio 桌面端）的登录是**微信扫码**，且授权页与回调都在
**它自己的 Electron 客户端**里，第三方无从走完 —— 所以上游不造 PKCE，而是
**读本机桌面端已经登录好的会话文件**：

```
%LOCALAPPDATA%\Programs\AStudio Data\userdata\astron-session.json
```

⇒ 两个必然结论：

1. **必须先在本机装 AStudio 桌面端并扫码登录过一次**，否则 `/admin` 里没有东西可导入。
2. **远程服务器部署时这条天然不通** —— 服务器上没有那个文件。用界面上的
   「+ 新建账号 → AStudio → 打开认证页」再自己把会话内容贴进去，或者用
   `DSH_ASTUDIO_SESSION_FILE=<路径>` 指到一份拷过去的会话文件。

**更省事的替代方案**：在本地登录好，再用 `/admin` 的「备份」导出 → 在服务器「恢复」导入。
导入有两种模式：

| 模式                 | 行为                                                 | 适用                     |
| -------------------- | ---------------------------------------------------- | ------------------------ |
| **整体还原**（默认） | 用备份内容**覆盖**整个账号池与模型黑名单             | 「恢复」按钮、整机迁移   |
| **单独导入**         | **只追加**账号，已存在的跳过，**不碰**黑名单与锁定表 | 从别人的备份里挑一个账号 |

> ⚠️ **「整体还原」会覆盖现有状态**：若备份里没有 OpenCode 匿名通道条目，导入后它会消失、
> `/v1/models` 随之变空。**重启一次即可恢复**（插件启动时会自动补一条）。只想加账号、
> 不想动现有配置时请选**「单独导入」**。

### 出不去墙外服务（Gemini / 出口代理）

`gemini`（Gemini Code Assist）是本项目里**必须过墙**的渠道：令牌端点
（`oauth2.googleapis.com/token`）、userinfo、Cloud Code 的配额与推理端点
（`cloudcode-pa.googleapis.com`）全部在墙外。

**典型症状**：浏览器**能**打开授权页并点「同意」，回到 `/admin` 却一直失败、账号列表里
始终没有这个号；或账号在，但积分和对话全部失败。这时**不要去查 `client_secret` 与
`redirect_uri`** —— 这是代理问题。

**根因**：浏览器读 **Windows 系统代理（WinINET）**，而插件跑在 Node 的 `fetch`
（undici）上，它**既不读系统代理、也不读 `HTTP(S)_PROXY`**。所以「浏览器能用、程序不能用」
是这个渠道最典型、也最容易误诊的形态。

两种配法，**任选其一**（① 优先）：

**① 给账号单独配出口代理（推荐）**

在 `/admin` 的 Gemini 面板里点账号卡片上的「**代理**」→ 填地址
（`http://127.0.0.1:7897` / `socks5://…` / 带认证的 `http://user:pass@host:port`）
→「测试连接」→ 保存。要点：

- 「测试连接」打的是 **Google 自己的端点**，不是通用的出口 IP 查询服务 —— 代理能通
  `ip-api` 却被 Google 拒的情况很常见，用后者会产生**假阳性**。
- 配好后该账号的**登录、续期、积分、对话**全部走这条出口，且每个账号可以配不同的代理。
- ⚠️ **重新登录会继承代理**：`refresh_token` 失效时面板提示的标准动作是「删号重登」，而重登
  会造一个**全新账号 id** —— 上游为此让新账号从**同类账号继承**代理。继承只在**恰好一个**
  Gemini 账号配了代理时生效（多个时无法判断该用哪个，宁可直连也不猜错出口）。所以重登前
  先确保只有一个号配着代理。
- ⚠️ 它只作用于 Gemini，与 **OpenCode 的「代理」是两份独立配置**（两个按钮、两个池字段），
  清掉其中一个不影响另一个。
- ⚠️ 代理配置随账号条目存进 `jet-hub/state.json`，因此会随 `/admin` 的备份导出/导入一起往返。

**② 启动前导出环境变量**

```powershell
# PowerShell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:HTTP_PROXY = 'http://127.0.0.1:7897'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
npm start
```

⚠️ **必须真的导出为环境变量**。只打开 Windows 设置里的「使用代理服务器」**对 Node 无效**
—— 那正是「浏览器能用、程序不能用」的原因。

⚠️ 与宿主 DSH 的差异（重要）：宿主 dsh 会在**第一个插件加载前**装全局代理分发器，
因此导出 env 就能覆盖全部请求。**本项目不是 dsh 宿主**，没有那层分发器；
只有 Node 24+ 带 `NODE_USE_ENV_PROXY=1` 时，内置 `fetch` 才读 `HTTPS_PROXY`。
所以在本项目里 **② 依赖 Node 版本 + 该变量**，稳妥做法仍是 ①。

**报错文案**：连不上时插件会明确提示「疑似需要代理」并带上根因码
（如 `UND_ERR_CONNECT_TIMEOUT`），登录失败、续期失败、积分查询失败与对话失败四条腿
给的是同一句指路文案，不再是裸 `fetch failed`。代理恢复后**无需重登**（凭据没被标失效，
后台续期会在下一轮接上）。

### 图片输入

**已支持**，要点：

- 只接受 **base64 内联的 `data:` URL**；外部 http(s) 链接**明确拒绝**（防 SSRF，理由见下）。
- 媒体类型按**字节硬校验**：声明 `image/jpeg` 而内容是 png 会被拒，不把坏图发给上游。
- 图片落 `<CODEARTS2API_HOME>/attachments/`，**内容寻址**（文件名 = sha256），重复发只存一份。
- 沿用官方限制：单张 ≤ 20MB、单条消息 ≤ 20 张 / 200MB、边长 ≤ 8192，支持
  `png` / `jpeg` / `webp` / `gif`。

发图**必须选声明了图片能力的模型**（`GET /v1/models` 的 `input` 含 `image`，例如
`opencode/mimo-v2.6-flash-free`）；用不支持的模型发图会被上游拒，与网关无关。

```bash
# B64 是图片的 base64；data:image/png 要与真实字节一致
curl -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"model\":\"opencode/mimo-v2.6-flash-free\",\"messages\":[{\"role\":\"user\",
       \"content\":[{\"type\":\"text\",\"text\":\"这是什么颜色？\"},
       {\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,$B64\"}}]}]}" \
  http://127.0.0.1:8326/v1/chat/completions
```

图片两端都要附件服务：**入站**由网关把 data URL 落成附件，**出站**由各渠道把字节
内联进上游请求。

#### 为什么不支持外部 `image_url`（设计说明）

**现状：拒绝**（`unsupported_content`）。这是**上游硬编码**的行为，本项目无法通过配置
打开 —— 见 `dsh-providers-hub/src/openai-gateway/images.ts`：

```ts
if (typeof url === "string" && !url.trim().startsWith("data:")) {
  throw new Error("网关暂不支持 http(s) 图片链接：出于安全考虑（避免 SSRF），" + "只接受 base64 内联的 data URL 图片。")
}
```

**为什么先不改（2026-10-03 的决定）**

- 大多数客户端拖图进对话框时**本来就转 base64**，URL 形态并不常见 —— 先观察。
- 让网关去下载外部 URL 是一个真实的 **SSRF** 面（能打环回、内网服务、云元数据端点
  `169.254.169.254`），且**响应内容会被模型看到** —— 等于把内网返回泄露给模型 / 日志。
- 本项目是**自用网关**，风险比上游设想的小；但风险取决于**部署形态**（是否被反代到公网、
  同机是否跑着别的内部服务），而不是「自用」这个词本身。

**将来若要支持（方案 B）**：在本项目的 `/v1/*` 反代层拦一道
（`src/server.js` 的 `proxyToGateway`）—— 检测 http(s) `image_url` → 下载 → 转 base64
data URL → 重写请求体再转发，**不改上游**。必须带的防护：

| 防护                                                                                  | 原因                    |
| ------------------------------------------------------------------------------------- | ----------------------- |
| 只允许 `https`                                                                        | 明文传输 + 降级攻击     |
| 解析 DNS 后拒绝私有 / 保留地址（`10.` / `192.168.` / `127.` / `169.254.` / `::1` 等） | SSRF 的核心防线         |
| 每次重定向都重新校验                                                                  | 否则一个 302 就绕到内网 |
| 超时 + 大小上限（≤20MB，与附件一致）                                                  | 防止挂死与内存打爆      |
| 环境变量开关（默认**关**）+ 文档写明风险                                              | SSRF 风险属运维决策     |

环境变量建议：`ALLOW_IMAGE_URL=1`（默认关，打开后 `/healthz` 回显该状态），
另可加 `ALLOW_IMAGE_URL_HOSTS=` 只放行受信任图床。

### 已知边界

- **网关关闭后**：`/v1/*` 会回 `502 gateway_unreachable` 并提示去 `/admin` 检查，
  而不是挂起或回 HTML 错误页。
- **`DSH_OPENAI_GATEWAY_ENABLED=0` 时**面板开关会被禁用并提示「已被环境变量停用」
  —— 这是上游的优先级设计（env > 面板），不是开关坏了。
- **端口冲突**（8326 被占用）：网关只记日志、跳过启动，不影响 `/admin`。

## 架构

本仓库是**薄胶水**：全部实现都是「把上游需要的宿主环境就位」，业务逻辑一行都不复制。
因此本仓库不含上游源码或其构建产物 —— `public/admin.js` 与 `public/upstream-jet-hub.js`
均由 `npm run build` 现场生成并被 `.gitignore` 排除，上游只通过 `package.json` 的
git 依赖引入。

### 宿主依赖面

上游插件的入口是 `apply(ctx)`，宿主依赖面只有这五个服务 —— 把它们就位后即可直接
`ctx.plugin()` 装载：

| 服务          | 本项目怎么做                                      | 为什么                                                                                             |
| ------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `credentials` | **复用官方** `@deepseek-ai/dsh-credentials-local` | 写 `<home>/.credentials.yaml`；自实现要重担格式 / 权限 / 原子写 / 锁，偏差表现为**静默读不到凭据** |
| `attachments` | **复用官方** `@deepseek-ai/dsh-attachment-local`  | 图片输入的地基（入站落盘 + 出站内联）。插件用 `ctx.get` 取它，**缺了不报错**、只静默失去图片能力   |
| `commands`    | 空对象                                            | 插件把它列在 `inject` 里但代码零调用；缺了会永久 pending                                           |
| `connection`  | 自实现注册表（`src/connection.js`）               | Jet Hub 管理端点经此接入，请求原样透传                                                             |
| `llm`         | **真实** `@deepseek-ai/dsh-llm` 的 `LlmRuntime`   | 网关与各渠道适配器都通过它发请求，不能替身                                                         |

> ⚠️ 凭据服务**必须走 `ctx.plugin()`**，不能 `new LocalCredentialProvider(...)`：载入既有
> 凭据的逻辑在它的 `[Service.init]` 生成器里，只有被 cordis 当作插件装载时才会执行 ——
> 手动 `new` 的实例**不会读磁盘上的既有凭据**且不报错（症状同样是「凭据未配置」）。

管理界面同理：上游的浏览器产物只 external 了 `react`，本项目用**两个 script 标签 + 一个
桩 ctx** 把它的 `JetHubPage` 捞出来渲染（见 `web/admin.jsx`）。因此**界面随上游走**，
本仓库不含任何布局代码，上游改版后重新 `npm run build` 即可。

### 依赖划分

**界面要用 react，为什么它不算运行期依赖？**

因为 `/admin` 是**构建期打包**：`npm run build` 用 esbuild 把 react / react-dom 与页面
代码一起打进 `public/admin.js`（自带 React 运行时、无外部 `require`）。运行期
（`node src/index.js`）**不加载 react**，只是把这份静态文件发给浏览器。

| 包                                                                                                | 分类              | 谁在用                                |
| ------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------- |
| `@deepseek-ai/cordis`、`dsh-llm`、`dsh-credentials`、`dsh-credentials-local`、`dsh-providers-hub` | `dependencies`    | **服务器进程运行期**真正 `import`     |
| `@deepseek-ai/dsh-attachment`、`dsh-attachment-local`                                             | `dependencies`    | 图片输入的地基（上游 `ctx.get` 取用） |
| `@deepseek-ai/dsh-commands`                                                                       | `dependencies`    | **没人 `import`**，纯粹为「钉住版本」 |
| `esbuild`                                                                                         | `devDependencies` | 只在 `npm run build` 时运行           |
| `react`、`react-dom`                                                                              | `devDependencies` | 只在构建期作为输入被读取；产物已内联  |
| `jsdom`                                                                                           | `devDependencies` | 只在 `npm test` 里模拟浏览器 DOM      |

> ⚠️ `@deepseek-ai/dsh-commands` 是**故意**列在依赖里的，虽然本项目的 `commands` 服务
> 只是个空对象（见上表）。它出现在这里只为**挡住 npm 的自动 peer 安装**：
> 上游把 `dsh-commands` 列为必需 peer，本仓库不钉它，npm 就会自己装「匹配范围内最新」
> 的那一版；而 DSH 基础包之间是**精确** peer（`dsh-commands@0.2.1-rc.3` 硬要
> `dsh-llm@0.2.1-rc.3`）⇒ 新旧混装，`npm install` 直接 ERESOLVE。
>
> 所以规矩是：**`@deepseek-ai/dsh-*` 必须整族同版本**，凡是上游列为必需 peer 的基础包
> 都要在 `package.json` 里钉住（升级脚本装完会自检，不一致就红）。

> ⚠️ 注意：`npm run build` **需要** devDependencies。若构建环境设了
> `NODE_ENV=production`，`npm install` 会默认跳过它们、构建直接失败 —— 故 Dockerfile 里
> 显式写了 `npm install --include=dev`。

## 开发

欢迎提 Issue / PR。

### 测试与规范

```bash
npm test              # 单元 / 集成测试（node --test）
npm run lint          # ESLint
npm run lint:fix      # ESLint 自动修
npm run format        # Prettier 写入
npm run format:check  # Prettier 只检查（CI 用）
```

代码风格为 `semi: false` / `printWidth: 120`（flat config）。项目特有的几点：

- **`eslint.config.js` / `.prettierignore` 排除两个编译产物**（`public/admin.js`、
  `public/upstream-jet-hub.js`）：它们不是本仓库代码，不排除会让 lint 从秒级变成分钟级，
  并让 `npm run format` 把上游代码重排一遍。
- **`.jsx` 显式列进 `files`**：flat config 默认只匹配 `*.js`，不写的话 `web/admin.jsx`
  会被**静默跳过**（不报错也不检查）。
- **Node 与浏览器端分别配置 globals**：`src/`、`tests/` 用 `globals.node`；
  `web/admin.jsx` 用 `globals.browser`。
- **`public/admin.html` 不排除** —— 它是手写源码（格式化后 `<script>` 的加载顺序不变，`/admin` 仍正常渲染）。
  顺序不变，`/admin` 仍正常渲染）。

> ⚠️ 两个产物由 `npm run build` 生成，被 `.gitignore` 与 `.prettierignore` 双重排除。
> **不要**提交或格式化它们。

### 测试覆盖

宿主装配（provider 路由注册与双向比对、端点挂载）、`/admin` 真实渲染、账号增删改查、
备份往返、网关启停（含端口真实释放）、模型 / 供应商开关、`/v1/*` 反代（含鉴权不被绕过、
网关不可达时的错误信封）、SSE 流式、状态目录隔离（不污染 `~/.dsh`）、凭据可读性、
关闭后无残留文件监听、**图片输入**（附件服务装配、落盘往返与内容寻址、mime 硬校验、
外部链接被拒、坏图报可读错）。

### 目录结构

```
src/
  index.js         进程入口：装配 → 监听 → 优雅退出
  host.js          宿主装配（五个服务 + 装载插件 + 契约核对）★核心
  upstream.js      对上游的全部假设（契约常量 + RPC 信封）
  connection.js    connection seam（管理端点注册表）
  server.js        HTTP：/admin、/api/jet-hub、/v1/* 反代、/healthz
  home.js          state home 解析（自己的目录，与 DSH 隔离）
  logger.js        cordis 日志 → stdout/stderr
  （credentials / attachments 用官方实现，无自实现文件）
web/admin.jsx      /admin 的薄入口（复用上游 JetHubPage）
public/admin.html  页面外壳（两个 script + loader shim）
build.mjs          前端构建（拷贝上游产物 + 打包入口）
tests/             行为测试（node --test）
eslint.config.js   ESLint（flat config，排除编译产物）
.prettierrc.json   代码风格
Dockerfile         容器构建
CHANGELOG.md       变更记录（新的在最前面）
```

### 自动升级（GitHub Actions）

工作流：`.github/workflows/upgrade-upstream.yml`。

| 项       | 值                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------- |
| 定时     | 每天 **北京时间 08:08**（cron 写的是 `8 0 * * *` —— GitHub 用 UTC 且按小时错开）                   |
| 手动触发 | Actions 页 → 该工作流 → **Run workflow**                                                           |
| 提交身份 | `upgrade-bot <upgrade-bot@users.noreply.github.com>`（不用 `github-actions[bot]`，那个看不出是谁） |
| 产物     | `package.json` / `package-lock.json` 的上游 hash + `CHANGELOG.md` 的一条新记录                     |
| 失败     | 步骤非零退出 ⇒ 工作流变红 ⇒ **GitHub 发失败通知邮件**；失败原因还会写进 Actions 的 Summary         |

> ⚠️ **失败通知要自己开**：GitHub 默认只给「订阅了通知」的人发邮件。若没收到，
> 在仓库的 **Settings → Notifications** 里把 Actions 的邮件打开，或在
> **Settings → Actions → General → Notifications** 里添加自己的邮箱。
>
> 失败时不必担心仓库被改坏 —— 脚本的每一步要么不落地，要么落地了就是对的：
> 依赖装不上会**回滚** `package.json` 与 `package-lock.json`；测试不过就**不提交**。

**为什么定时任务不会误伤仓库**：上游没更新时脚本**直接退出**，工作区一个字节都不动，
推送步骤也会检测到「没有改动」而跳过。

## 变更记录与升级

历次变更记在 [`CHANGELOG.md`](CHANGELOG.md)（**新的在最前面**）—— 上游每个版本改了什么、本仓库验证结果。本节说明它的组织方式、与上游的耦合面，以及升级流程。

「上游升级」条目记录的是 [`dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub)
依赖的更新。本项目的核心特色是**薄胶水** —— 上游改业务逻辑时我们通常 **0 行代码改动**，
这些条目就是历次验证。

### CHANGELOG 怎么写

- 每条写成 `<details>` + `<summary><b>日期 · 标题</b></summary>`，正文跟在后面 ——
  **标题本身就是折叠栏**，不再另加「展开/收起」文案。
- **最新一条**用 `<details open>`（默认展开，但一样能手动收起）；更早的条目用
  `<details>`。两者形式完全一致，只是初始状态不同。
- **同一天的多次变更合并成一条**，内部用 `###` 分小节，避免同日期条目散成好几段。
- ⚠️ `<summary>` 是 HTML 上下文，**行内代码要用 `<code>x</code>`**（反引号在那里不会被
  渲染）；正文里照常使用反引号。
- 新增条目时：把**上一条**的 `open` 去掉，新条目加在文件顶部并带 `open`。

### 升级时需要改多少代码

我们与上游的**代码**耦合只有一处：

```js
import * as plugin from "dsh-providers-hub" // src/host.js 唯一的一行
```

其余全靠 cordis 的注入机制与 HTTP 转发。因此上游常见的改动类型（新增渠道、修协议、
改额度逻辑、加模型、改 UI 布局）**都不需要动本仓库**：

| 上游改了什么                      | 我们要改                         | 为什么                                                    |
| --------------------------------- | -------------------------------- | --------------------------------------------------------- |
| 新增一个渠道（provider）          | **0 行**                         | 我们不含任何渠道名单，界面与 `provider.status` 都是动态的 |
| 改某个渠道的协议/登录             | **0 行**                         | 逻辑全在上游                                              |
| 改界面布局 / 样式                 | **0 行**（只需 `npm run build`） | 界面是上游产物的原样复用                                  |
| 改网关行为（/v1/\*）              | **0 行**                         | 网关是上游的，我们只转发                                  |
| 加 RPC 方法                       | **0 行**                         | 我们的转发是通用透传，不枚举方法                          |
| **改管理端点路径**                | 1 个常量                         | `src/upstream.js`                                         |
| **改 RPC 信封 / 线协议**          | 1 个函数                         | `src/upstream.js` 的 `rpcEnvelope()`                      |
| **改客户端 loader 形态**          | 可能 1~2 处                      | `public/admin.html` + `web/admin.jsx`                     |
| **改 slot 名 `settings.section`** | 1 个常量                         | `src/upstream.js`                                         |
| **改插件 `inject` 列表**          | `src/host.js` 的 provide         | 少了服务插件会永久 pending                                |

### 升级流程

> ⚠️ **本仓库已把上游升级脚本化**：日常升级由
> [`scripts/upgrade-upstream.mjs`](scripts/upgrade-upstream.mjs) 完成，
> GitHub Actions 每天北京时间 **08:08** 自动跑一次（也可在 Actions 页手动触发）。
> 下面这一节保留**手工流程**，用于「脚本跑挂了要人工兜底」或「想手动看每一步」。
>
> ```bash
> npm run upgrade:upstream        # 查上游 → 有更新才继续 → 安装 → 构建 → 测试 → 写 CHANGELOG → 提交
> npm run upgrade:upstream -- --dry-run   # 只查不装，看上游有没有新 commit
> ```

脚本的行为：上游 hash **没变就直接跳过**（不装、不构建、不改文件、不提交）；变了就
跑完整条链路，**自动**把上游这一段的 commit 标题写进 `CHANGELOG.md`（只取标题，
不取正文），并自动 `git commit`。任何一步失败都会**非零退出**并留下详细日志 ——
GitHub Actions 因此会发失败通知邮件。

自动升级跑完后，**测试不需要改**：provider 名单的断言是「期望 ⊆ 实际」
（**只防删、不防增**），渠道总数与渠道文案都**不写死**。上游新增渠道时，
本仓库的测试与文档**零改动**（这正是当初把它们改成单向断言的原因）。

| 脚本步骤                    | 失败时说明                                                                     | 怎么办                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `npm install`               | 上游拉取或编译出错                                                             | 看日志；多半是上游刚发版触发了 pnpm 的「新包冷却期」                                        |
| `npm install`（ERESOLVE）   | DSH 基础包**新旧混装**：上游放宽了 peer 范围，npm 自动装了「范围内最新」的一版 | 把没钉的基础包补进 `dependencies` 并钉到**与其它基础包同一版本**（见[依赖划分](#依赖划分)） |
| `DSH 基础包整族同版本` 自检 | 没打架但装了两套（不同版本共存）                                               | 同上；修完 `rm -rf node_modules package-lock.json && npm install`                           |
| `package-lock.json` 核对    | lock 静默沿用了旧 commit                                                       | 脚本会自动回滚，照错误信息里的命令手工处理                                                  |
| `npm run build`             | 上游产物形态变了（`./client` 导出路径不同）                                    | 对照 [README 上游契约表](#升级时需要改多少代码)                                             |
| `npm test`                  | 上游改了契约（端点路径 / 删了渠道 / 新外部依赖）                               | 按报错改 `src/upstream.js` 的常量或 `web/admin.jsx` 的 shim                                 |
| `npm run lint` / `format`   | 本仓库代码风格问题                                                             | `npm run format` 修                                                                         |
| `git commit`                | 权限或并发冲突                                                                 | 看 Actions 日志                                                                             |

**回滚**：自动升级的 commit 是**一个** commit 里包含依赖变更 + CHANGELOG 条目，
`git revert <那个 commit>` 即可整体回退；也可以照下面的手工流程装回旧 commit。

### 手工流程（脚本跑挂了要人工兜底时用）

**1. 查上游最新 commit**

```bash
git ls-remote https://github.com/iJetLi/dsh-providers-hub.git refs/heads/master
# 输出形如：<40 位 commit hash>  refs/heads/master
```

> ⚠️ 上游默认分支叫 **`master`**（这仓库没有 `main`）。写错分支名时 `git ls-remote`
> 会**成功但输出空**，升级脚本于是报「上游 ls-remote 没有返回 … 分支」。

本地有 clone 的话，也可以 `git fetch origin` 后
`git log --oneline <当前锁的commit>..origin/master` 看这次改了什么。

**2. 更新依赖（⚠️ 别只改 package.json）**

```bash
NEW=<第 1 步拿到的 commit>
npm install "dsh-providers-hub@git+https://github.com/iJetLi/dsh-providers-hub.git#$NEW" \
  --include=dev --no-audit --no-fund
```

> ⚠️ **必须用上面的写法（带包名与 `@` spec）。** `package-lock.json` 里记着旧 commit 的
> `resolved`，只改 `package.json` 再 `npm install` 会**静默沿用 lock 里的旧 commit**
> （只输出 `added 1 package`、不报错），看起来升级了、实际没有。
>
> 若已发生这种情况，两个文件都改成新 commit 后 `rm -rf node_modules/dsh-providers-hub && npm install`。
> 升级后务必核对：`node -e "console.log(require('./package-lock.json').packages['node_modules/dsh-providers-hub'].resolved)"`

`npm install` 会重新 clone 上游并跑它的 `prepare`（`pnpm build:all`）现场编译 `lib/` ——
所以要**确保 pnpm 可用**（`corepack enable`）。

> ⚠️ 上游若刚发布了新版 DSH 基础包，pnpm 11 的**新包冷却期**（默认 24 小时）会拒绝
> 安装它自己锁文件里的那些包。此时加前缀：
> `PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 npm install …`（说明见
> [快速开始](#快速开始) 的同名提示）。

> ⚠️ **npm 11 的 `allow-scripts` 可能让这条命令在「git dep preparation」阶段失败**
> （报 `EALLOWSCRIPTS: --allow-scripts is not allowed in project-scoped installs`，
> 看起来像网络/上游问题）。原因是 `~/.npmrc` 里的 `allow-scripts=true` 被 npm 11 当成
> 命令行参数拒掉，而报错发生在**上游克隆目录里跑的第二次 npm** 里。绕过方式是指定一个
> 不含该键的 userconfig：
>
> ```bash
> npm install "dsh-providers-hub@git+…#$NEW" --include=dev --no-audit --no-fund \
>   --userconfig /tmp/clean-npmrc      # 内容只需一行 registry=…
> ```
>
> 清空 `NPM_CONFIG_ALLOW_SCRIPTS` 环境变量**无效**（值来自 `~/.npmrc`）。详见 CHANGELOG。

**3. 重建前端产物（必做）** —— 界面的 JS 是上游产物的拷贝，不重建就还是旧界面：

```bash
npm run build
```

**4. 测试与规范**

```bash
npm test              # 行为测试
npm run lint          # 上游若改了产物形态，这里能发现我们的代码跟不上了
npm run format:check  # 确认代码风格一致
```

按失败信息处理：

| 失败的是                                               | 说明                     | 怎么办                                                    |
| ------------------------------------------------------ | ------------------------ | --------------------------------------------------------- |
| `host.test.mjs` 的「provider 不见了」                  | 上游**删除/改名**了渠道  | 按报错给出的实际列表更新 `EXPECTED_PROVIDERS`（只改测试） |
| `admin-ui.test.mjs` 的「只请求我们 shim 能提供的模块」 | 上游引入**新的外部依赖** | 在 `web/admin.jsx` 的 `captured.factory()` 里补上该模块   |
| `home-isolation.test.mjs`                              | 存储格式/隔离被改坏      | 看具体断言，通常与 `src/home.js` 或凭据服务有关           |
| `format:check` 报**已有文件**（不是本次改的）          | 工作区行尾漂移           | 见下方「行尾」；**不要**用 `format` 去「修」代码          |
| 其它                                                   | 契约漂移                 | 对照 `src/upstream.js` 顶部契约表                         |

> ⚠️ **行尾陷阱**：Git `core.autocrlf=true` 时工作区会被检成 CRLF，而 Prettier 默认
> `endOfLine: "lf"` ⇒ 一批**本来没动过**的文件也会报格式错误（`format` 还会把它们整份
> 重写）。先确认是不是这个原因：
>
> ```powershell
> git ls-files --eol | Select-String 'w/crlf'
> ```
>
> 有输出就是行尾问题，把这些文件转回 LF 即可，**不要**去改内容。

**5. 启动确认契约（关键一步）**

```bash
npm start
```

启动日志里必须有这一行：

```
[codearts2api] 上游契约核对通过：/api/jet-hub, /api/jet-hub/captcha-carrier
```

**没有这行、或直接抛错**，就说明上游改了端点路径或装配方式 —— 错误信息会告诉你去
`src/upstream.js` 改哪个常量。

**6. 真机点一下（建议）** —— 打开 `/admin`，确认：左侧导航里各个渠道都在、账号列表能读出
source、页头「网关」开关能开关。

**回滚**

```bash
npm install "dsh-providers-hub@git+https://github.com/iJetLi/dsh-providers-hub.git#<旧commit>" --include=dev
npm run build && npm test
```

> 💡 升级只改 `package.json` / `package-lock.json` / `public/*.js`（产物）。
> **账号数据在 `~/.codearts2api`，与升级无关**。想稳妥可以升级前在 `/admin` 里导出一份备份。

查当前锁定版本：

```bash
node -e "console.log(require('./package.json').dependencies['dsh-providers-hub'])"
```

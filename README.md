# codearts2api

把 [`dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub) 的
**Jet Hub 多渠道账号管理**与**本机 OpenAI 网关**搬到独立后端运行，**不依赖 DSH 宿主**，
面向自建服务与容器部署。

它不 fork 上游代码，而是直接把上游的插件装载起来 —— 所以**渠道、模型、协议、界面
都跟着上游走**，本项目自己只负责鉴权、状态隔离与对外接口。

<img width="1277" height="919" alt="总览界面" src="https://github.com/user-attachments/assets/b3fc1739-37b5-43b1-a927-78c4b706fec7" />

<img width="1920" height="1031" alt="Jet Hub 管理界面（上游设置页原样复用）" src="https://github.com/user-attachments/assets/0fc7e323-2830-49e0-898f-88e28c631a71" />

## 使用方法

### Docker 部署

推荐用镜像跑。`CODEARTS2API_HOME=/data` 已由镜像设好并声明为 `VOLUME`，**不挂卷则容器
重建后账号会丢**。

```bash
docker pull ghcr.io/zhuweiyou/codearts2api:latest
docker run -d --name codearts2api \
  -p 8080:8080 \
  -v codearts2api-data:/data \
  ghcr.io/zhuweiyou/codearts2api:latest
```

也可以在仓库根目录自行构建：`docker build -t codearts2api .`，再把上面的镜像名换成
`codearts2api` 运行。

首次启动会在 `/data/admin-key` 生成管理密钥，用它登录后台：

```bash
docker exec codearts2api cat /data/admin-key
```

打开 `http://<主机>:8080/admin` 进入。管理接口自带鉴权，`-p 8080:8080` 不会把后台直接
暴露给公网；公网部署仍需自行终结 TLS（见 [`AGENTS.md`](AGENTS.md)）。

### 本机直跑

**要求**：Node.js `^22.19.0 || >=24.0.0`（建议 24+）。

```bash
npm install
npm run build
npm start
```

启动后打开 <http://127.0.0.1:8080/admin>。首次启动会在日志里打印一次管理密钥
（默认状态目录 `~/.codearts2api`，可用 `CODEARTS2API_HOME` 指定），用它在登录页进入后台。

### 管理界面

`/admin`（登录后）顶栏是三个一级页面：

- **总览**（默认首页）：网关状态、今日用量、近 14 日趋势、渠道账号与余额、积分收支、
  模型分布、自动签到；
- **渠道管理**：上游 Jet Hub 设置页原样复用 —— 左侧为各渠道，页头「网关」按钮可查看
  对外地址、复制 API Key 与模型清单；
- **调用方**：多把 Key 与分组授权（见下）。

顶栏右侧还有 **「回调修复」**（远程部署时第三方登录跳回 `127.0.0.1` 打不开，可让服务器
本机重放）与**主题切换**（跟随系统 / 浅色 / 深色）。

### 多把调用方 Key（分组授权）

默认只有一把网关 Key。要「按人发 Key、按人限模型、按人看用量」时，用顶栏「调用方」页：

- **一把 Key 一个人**，可单独停用 / 删除；
- **分组决定能调哪些模型**（白名单）；
- **用量按人按模型记账**，只记元数据，不落 prompt / 回复正文。

在「分组」页建分组、勾白名单，在「Key」页新建并发给对方（明文只显示一次）。
`<home>/caller-keys.json` 不存在时该功能不生效，删掉即回滚。

## API

### HTTP 接口

| 路径                                                                | 说明                                             |
| ------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /admin`                                                        | 管理界面（登录页 → 上游 Jet Hub 设置页）         |
| `POST /api/jet-hub`                                                 | Jet Hub 管理 RPC（上游实现原样透传，需管理密钥） |
| `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses` | OpenAI 兼容接口（上游网关，需网关 Key）          |
| `GET /healthz`                                                      | 健康检查（不含密钥，可给监控用）                 |

### 鉴权

两把钥匙，别混用：

| 密钥         | 位置                            | 给谁       | 权限                             |
| ------------ | ------------------------------- | ---------- | -------------------------------- |
| **管理密钥** | `<home>/admin-key`              | 只有你自己 | 进后台、改配置、导出全部账号凭据 |
| **网关 Key** | `<home>/openai-gateway/api-key` | 调用方     | 只能调 `/v1/*` 推理接口          |

脚本 / curl 直接带 `Authorization: Bearer <admin-key>` 访问 `/api/jet-hub`。

### OpenAI 兼容接口

登录 `/admin` → 页头「网关」按钮 → 拿实际地址、API Key 与模型清单。客户端把 `base_url`
指向网关、`api_key` 填网关 Key。模型 ID 形如 `provider/模型名`（如
`codearts/deepseek-v4.1-flash`），**必须带渠道前缀**，可用模型以 `GET /v1/models` 为准。
支持 SSE 流式与 base64 内联图片输入。

### 聚合路由

| 路由                     | 行为                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `aggregate/<规范模型名>` | 把同一模型在各渠道的条目归一化，按额度临期顺序选号，失败时切换下一个候选 |
| `jet-hub-auto/auto`      | 在候选渠道中自动挑选可用者与模型                                         |

需先配置好对应渠道的账号，否则目录为空；可在 `/admin` 的「聚合 (跨渠道)」面板设置轮换。

---

🛠 完整的镜像标签、环境变量、状态目录、账号迁移、反向代理、安全边界、常见问题，以及
架构 / 测试 / 上游升级流程等开发内容，见 [`AGENTS.md`](AGENTS.md)。历次变更见
[`CHANGELOG.md`](CHANGELOG.md)。

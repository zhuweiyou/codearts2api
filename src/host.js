/**
 * 宿主装配：用**纯 cordis** 把插件跑起来。
 *
 * ## 本文件是整个项目的核心，也是唯一「薄胶水」
 *
 * 上游插件是个 cordis 插件，入口是 `apply(ctx)`，声明
 * `inject = ['credentials', 'commands', 'llm']`，并在内部
 * `ctx.inject(['connection'], …)` 注册管理端点。它**不依赖任何 DSH 专有
 * 宿主对象** —— 只要把这些服务按最小面提供出来，插件就会完整地跑：
 *
 * - `credentials`：**直接复用官方实现** `@deepseek-ai/dsh-credentials-local`
 *   （写 `<home>/.credentials.yaml`）。见下方「为什么不自实现」；
 * - `attachments`：**直接复用官方实现** `@deepseek-ai/dsh-attachment-local`
 *   （图片落 `<home>/attachments/`）。图片输入靠它，见下方「图片输入」；
 * - `commands`：**空对象**。插件只是把它列在 `inject` 里，代码零调用
 *   （已 grep 确认 `ctx.commands` 无引用），但缺少它插件会永久 pending；
 * - `connection`：自实现注册表（见 `connection.js`），Jet Hub 端点由此接入；
 * - `llm`：**真实**的 `LlmRuntime`（来自 `@deepseek-ai/dsh-llm`）。
 *   网关与各 provider 适配器都通过 `ctx.llm` 发请求，这里不能替身。
 *
 * ## 图片输入（attachments）
 *
 * 客户端发来的图片走两条路，**两端都要 attachments 服务**：
 *
 * 1. **入站**（网关）：OpenAI 的 `image_url` data URL → 调
 *    `saveImage({data, mediaType})` 落成附件，再以 `ImageBlock` 交给模型。
 *    没有它，网关收到图片会**明确报错**「未装载附件服务」（不会静默丢图）。
 * 2. **出站**（适配器）：把附件读回字节内联进上游请求，用 `readImage(ref)`；
 *    `readImageRequest(ref, target)` 可选（拿缩放版，失败自动回退原图）。
 *
 * ⚠️ 插件是用 `ctx.get('attachments')` 取它的（**不是** `inject`），因此服务
 * 缺失时**不报错**、只是静默失去图片能力 —— 必须在 `ctx.plugin(plugin)`
 * **之前**装载，否则插件启动时读到的就是 undefined。
 *
 * ## 为什么凭据用官方实现，而不是自己写一个
 *
 * 第一版自己写了个「文件版凭据服务」，写的是 `<home>/jet-hub/credentials.json`
 * —— 结果**读不到任何已有凭据**（真实故障：界面一直提示「凭据未配置」）。
 * 根因是那个文件格式是我**臆造**的；真实 DSH 的凭据文档是
 * `<home>/.credentials.yaml`，且它在启动时由**权威实现**解析。
 *
 * 自己再实现一遍「看起来一样」的读写，等于把「格式」「权限校验」
 * 「原子写」「跨进程锁」「注释与 records 段不被抹掉」这些细节全部重担一遍，
 * 而任何一处偏差都表现为**静默读不到凭据**。所以这里直接用官方包。
 *
 * ⚠️ **必须走 `ctx.plugin()`，不能 `new LocalCredentialProvider(...)`**。
 * 那个类的载入逻辑在 `[Service.init]` 生成器里（`loadInitial()`），只有被
 * cordis 作为插件装载时才会跑。手动 `new` 出来的实例不会读磁盘上的既有
 * 凭据 —— 症状同样是「凭据未配置」，且**不报任何错**（已实测确认）。
 *
 * ## 装配顺序是硬约束
 *
 * `inject` 在**装载时**求值：四个服务必须在 `ctx.plugin(plugin)` 之前就位，
 * 否则插件会停在 pending 上（不报错、也不注册任何端点，极难排查）。
 */

import { Context } from "@deepseek-ai/cordis"
import AttachmentLocal from "@deepseek-ai/dsh-attachment-local"
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local"
import LlmRuntime from "@deepseek-ai/dsh-llm"
import { connect } from "node:net"
import { join } from "node:path"
import * as plugin from "dsh-providers-hub"

import { createConnection } from "./connection.js"
import { pinHome } from "./home.js"
import { installLogger } from "./logger.js"
import { CARRIER_PATH, JET_HUB_PATH, rpcEnvelope } from "./upstream.js"

/** 凭据文档名（与官方实现一致）。 */
const CREDENTIALS_FILENAME = ".credentials.yaml"

/**
 * 读当前网关监听端口（未运行时 `undefined`）。
 *
 * 走**公开的 RPC 接口**而不是去 import 插件的内部模块 —— 那些模块不在包的
 * `exports` 里（只有 `.` / `./client` / `./locale/*` / `./package.json`），
 * 深路径 import 会 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
 */
async function currentGatewayPort(connection) {
  const route = connection.routes.get(JET_HUB_PATH)
  if (route === undefined) return undefined
  try {
    const response = await route.fetch(
      new Request(`http://127.0.0.1${JET_HUB_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpcEnvelope("gateway.getEnabled", {}, "close-probe")),
      }),
    )
    const parsed = await response.json()
    const address = parsed?.result?.value?.address
    return typeof address?.port === "number" ? address.port : undefined
  } catch {
    // 探测失败不该阻塞关闭：最坏情况是少等一会儿（下面有 setImmediate 兜底）。
    return undefined
  }
}

/** 端口是否已可重新绑定（= 旧监听已释放）。 */
function portReleased(port, timeoutMs = 200) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port })
    const done = (released) => {
      socket.destroy()
      resolve(released)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once("connect", () => done(false))
    socket.once("error", () => done(true))
  })
}

/**
 * 等网关真正把端口交还。
 *
 * ## 为什么必须等（真实故障）
 *
 * 插件的网关运行时是**模块级单例**，且它的清理器是 fire-and-forget：
 *
 * ```ts
 * ctx.effect(() => () => { void disposeGatewayRuntime() }, 'openai-gateway')
 * ```
 *
 * `void` 让 `fiber.dispose()` **不等**网关关闭就返回。于是旧实例的
 * `disposeGatewayRuntime()` 会在新实例起来**之后**才落地，而它是这样写的：
 *
 * ```ts
 * factory = undefined; lastApiKey = null
 * ```
 *
 * 这两行会把**新实例**注册的工厂与密钥一起抹掉 —— 症状是新实例
 * `gateway.getEnabled` 里 `apiKey` 突然变成 null、甚至网关被关掉。
 * 本仓库单进程部署时只有「启动 → 关闭」一次，因此线上不会踩到；但
 * `SIGTERM` 重启、测试里的多实例都会踩。这里用「等端口释放」把它变成确定性。
 *
 * ⚠️ 超时上限 5 秒：宁可多等一会儿，也不要让一次关闭把下一个实例搞坏。
 */
async function waitForGatewayRelease(port) {
  if (port === undefined) return
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await portReleased(port)) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  // 让 dispose 尾部那两个同步赋值（factory / lastApiKey）确定的落地。
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * 启动插件宿主。
 *
 * @returns `{ ctx, home, routes, handleRpc, close }`
 *   - `handleRpc(path, request)`：把 HTTP 请求交给插件注册的 handler；
 *   - `close()`：按 cordis 生命周期回收（停刷新定时器、关子进程、关网关）。
 */
export async function createHost() {
  // ⚠️ 必须在装载任何东西**之前**钉住 home：插件内部多个模块在**模块作用域**
  //    或首次调用时读 `DSH_HOME`，晚一步就会有文件落进 DSH 的目录。
  const home = pinHome()

  const ctx = new Context()
  // 先接日志：此后插件加载期的告警（缺服务、端点注册失败等）才看得见。
  installLogger(ctx)

  // ① credentials：官方实现 + **显式 path**。
  //
  //    ⚠️ 显式给 `path` 而不是只给 `dshHome`：`path` 是最高优先级，
  //    能完全绕开 `dsh-home-paths` 对 `DSH_HOME` / `~/.dsh` 的解析。
  //    我们的 home 已经由 `pinHome()` 钉好，两边一致；显式写出来是为了
  //    让「凭据到底落在哪个文件」在代码里一眼可见，不依赖环境变量正确。
  //
  //    ⚠️ `watch: true` 会在进程里挂一个 chokidar 文件监听。它归**这个**
  //    子 fiber 所有，而 `close()` 里 dispose 的是**插件**的 fiber
  //    —— 两者是兄弟，互不牵连。若不额外处理，监听会活到进程结束，
  //    表现为 `npm test` 跑完不退出（`node --test` 等所有 handle 释放）。
  //    因此 `close()` 走**根 fiber** 的级联 dispose，而不是只 dispose 插件。
  await ctx.plugin(LocalCredentialProvider, {
    path: join(home, CREDENTIALS_FILENAME),
    // 与 DSH 一致：开启监听，用户在外部编辑器改凭据后无需重启。
    // （`assertOwnerOnly` 会校验权限，写入用的是原子写 + 跨进程锁。）
    watch: true,
  })

  // ② commands：仅为满足插件的静态 inject（代码零调用）。
  ctx.provide("commands", {})

  // ③ attachments：**官方实现**，让图片输入可用（网关入站 + 适配器出站都读它）。
  //
  //    ⚠️ 位置必须在这里：插件的 `apply()` 内部用 `ctx.get('attachments')` 取它
  //    （不是 `inject`，故缺了也不报错，只是**静默失去图片能力**）。若晚于
  //    `ctx.plugin(plugin)` 提供，插件启动时读到的仍是 undefined，网关就永远
  //    拿不到 `saveImage` —— 症状是收到图片回「未装载附件服务」。
  //
  //    两端的用法（都已实测）：
  //    - **入站**（网关）：`saveImage({data, mediaType})`
  //      → `{ attachmentId: 'sha256:…', mediaType, width, height, bytes }`；
  //      内容寻址（同图同 id），媒体类型按字节硬校验（声明不符会被拒）；
  //    - **出站**（适配器把图内联进上游请求）：`readImage(ref)` → `{data, ref.mediaType}`；
  //      另有 `readImageRequest(ref, target)` 供按目标尺寸取缩放版。
  //
  //    ⚠️ 显式传 `dshHome: home`：该包默认会经 `dsh-home-paths` 自行解析
  //    `DSH_HOME` / `~/.dsh`。我们已用 `pinHome()` 钉过环境变量，这里再显式传
  //    一次，是为了让「图片存在哪」在代码里一眼可见、不依赖环境正确
  //    （与凭据服务显式给 `path` 同一个理由）。
  await ctx.plugin(AttachmentLocal, { dshHome: home })

  // ③ connection：Jet Hub 管理 RPC 的唯一接入点。
  //    ⚠️ 必须 provide `connection.service`（那个带 `fetch.register` 的对象），
  //    **不是** `createConnection()` 的整个返回值 —— 后者还挂着本仓库自用的
  //    `routes` / `handle`。provide 整个返回值会让插件读到没有 `fetch` 的对象，
  //    症状是启动日志里一条 `connection.fetch not available`，然后**所有**
  //    管理接口 404。
  const connection = createConnection()
  ctx.provide("connection", connection.service)

  // ④ llm：真实的 LLM 运行时。必须在 ctx.plugin 之前构造（它自己 provide）。
  new LlmRuntime(ctx)

  // ⑤ 装载插件。返回的是 thenable 的 Fiber，await 即「apply 已完成」。
  //    此处不 try/catch：插件装不上就是致命错误，不该带着残缺状态继续服务。
  const fiber = await ctx.plugin(plugin)

  // ⑥ 核对上游契约 —— **启动即失败，而不是等用户点到某个按钮才 404**。
  //
  //    本仓库是薄胶水，唯一会随上游升级漂移的就是这些「约定的路径/名字」。
  //    不校验的后果：管理界面所有请求返回 404，而日志里一行提示都没有，
  //    用户只能看到界面一片空白（相关教训：第一版把 connection 服务
  //    provide 错了对象，同样是「全 404 且无提示」，排查了很久）。
  //
  //    ⚠️ 只断言**必须**存在的那个端点。载体页是可选功能（zcode 专用），
  //    上游若去掉它，其余功能不该被拖死，故只在缺失时记一条告警。
  if (!connection.routes.has(JET_HUB_PATH)) {
    const registered = [...connection.routes.keys()]
    throw new Error(
      `上游插件未注册预期的管理端点 ${JET_HUB_PATH}（实际注册：${registered.join(", ") || "无"}）。` +
        "这通常意味着上游改了端点路径或装配方式 —— 请对照 src/upstream.js 顶部的契约表逐条核对，" +
        "并把该文件里的常量改成上游的新值。",
    )
  }
  if (!connection.routes.has(CARRIER_PATH)) {
    ctx.logger?.warn?.(`[codearts2api] 上游未注册载体页 ${CARRIER_PATH}（可选功能，不影响其它能力）`)
  }
  ctx.logger?.info?.(`[codearts2api] 上游契约核对通过：${[...connection.routes.keys()].join(", ")}`)

  return {
    ctx,
    home,
    /** 凭据文档路径（供 /healthz 自查）。 */
    credentialsFile: join(home, CREDENTIALS_FILENAME),
    /** 插件已注册的 HTTP 路由（`path → route`）。 */
    routes: connection.routes,
    /** 转发一条请求给插件端点；未注册的 path 返回 undefined。 */
    handleRpc: (path, request) => connection.handle(path, request),
    /**
     * 优雅关闭。
     *
     * ## 顺序是刻意的：先探端口 → 再 dispose → 再等端口释放
     *
     * `fiber.dispose()` 只保证「effect 清理器被调用」，**不保证**其中的
     * fire-and-forget 异步工作（网关关闭）已完成 —— 见
     * {@link waitForGatewayRelease} 的说明。因此必须在 dispose **之前**
     * 记下端口，dispose **之后**等它真正释放，否则下一个实例会踩到旧实例
     * 迟到的清理。
     *
     * ## 必须 dispose **根** fiber，而不是插件自己的 fiber
     *
     * 凭据服务是另一个 `ctx.plugin(...)` 调用装出来的，它有**自己的** fiber，
     * 与插件的 fiber 是兄弟关系 —— dispose 其中一个不会碰到另一个。只
     * dispose 插件的话，凭据服务打开的 chokidar 文件监听会一直活到进程结束：
     * 表现为 `npm test`/`node --test` 跑完**不退出**，容器里 `SIGTERM` 之后
     * 也迟迟不退（只能等强杀兜底）。
     *
     * 根 fiber 的 dispose 会**级联**所有子 fiber，故这里用它。
     * `fiber`（插件那支）仍用于 {@link waitForGatewayRelease} 的端口探测。
     */
    close: async () => {
      const port = await currentGatewayPort(connection).catch(() => undefined)
      const root = ctx.fiber
      if (root !== undefined && typeof root.dispose === "function") await root.dispose()
      else if (fiber !== undefined && typeof fiber.dispose === "function") await fiber.dispose()
      await waitForGatewayRelease(port)
    },
  }
}

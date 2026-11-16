/**
 * 与上游插件的**契约常量**集中在这里。
 *
 * ## 为什么要单独一个文件
 *
 * 本仓库是「薄胶水」，全部脆弱性都来自**对上游约定的假设**。把这些假设
 * 散落在各文件里（`server.js` 一处常量、`host.js` 一处字面量），升级上游
 * 时要靠 grep 找全，漏一处就是「一半能用一半 404」。
 *
 * 集中之后，上游改名/改协议时**改这一个文件**即可，且 `UPSTREAM_CONTRACT`
 * 会把这些假设显式列出来，方便升级时逐条核对。
 *
 * ## 目前依赖上游的哪些约定
 *
 * | 约定 | 上游出处 | 变了会怎样 |
 * | --- | --- | --- |
 * | 管理端点路径 `/api/jet-hub` | `src/jet-hub-rpc.ts` 的 `JET_HUB_API_PATH` | 管理界面全部 404 |
 * | 载体页路径 `/api/jet-hub/captcha-carrier` | `CAPTCHA_CARRIER_PATH` | 仅 zcode 载体页 404（可选功能） |
 * | RPC 信封 `{type,rpcId,method,payload}` | `registerJetHubEndpoints` 的校验 | 管理界面全部报错 |
 * | 客户端 loader `window.__ModuleLoader__.load` | `plugin-src/client/build.mjs` | `/admin` 白屏 |
 * | slot 名 `settings.section` | `plugin-src/client/index.js` | `/admin` 抛出「未注册」 |
 * | 插件 `inject = ['credentials','commands','llm']` | `src/index.ts` | 缺服务则永久 pending |
 * | 网关绑 `127.0.0.1` | `openai-gateway/config.ts` | 容器必须走反代 |
 */

/** Jet Hub 管理端点路径（上游 `JET_HUB_API_PATH`）。 */
export const JET_HUB_PATH = "/api/jet-hub"

/** zcode 内部载体的载体页路径（上游 `CAPTCHA_CARRIER_PATH`，可选功能）。 */
export const CARRIER_PATH = "/api/jet-hub/captcha-carrier"

/** RPC 线协议里的端点名（上游 `JET_HUB_ENDPOINT`）。 */
export const JET_HUB_ENDPOINT = "jet-hub"

/** 客户端 bundle 会注册的 slot 名（我们据此把页面组件捞出来）。 */
export const SETTINGS_SECTION_SLOT = "settings.section"

/** 服务端 RPC 的规范错误信封里用到的字段（仅文档用途）。 */
export const UPSTREAM_CONTRACT = Object.freeze({
  managementPath: JET_HUB_PATH,
  carrierPath: CARRIER_PATH,
  endpoint: JET_HUB_ENDPOINT,
  clientLoader: "window.__ModuleLoader__.load",
  settingsSlot: SETTINGS_SECTION_SLOT,
  requiredServices: ["credentials", "commands", "llm"],
  gatewayHost: "127.0.0.1",
})

/**
 * 构造一条 Jet Hub RPC 请求体。
 *
 * 三处（`/healthz` 探活、关闭前的端口探测、浏览器端 `rpcCall`）都用同一份
 * 信封形状；写成函数可以避免它们各自漂移 —— 上游改协议时只改这里。
 *
 * @param method - RPC 方法名，如 `gateway.getEnabled`。
 * @param payload - 方法载荷。
 * @param rpcId - 请求 id；默认生成一个。
 */
export function rpcEnvelope(method, payload, rpcId = "rpc") {
  return {
    type: "client-request",
    rpcId,
    method: JET_HUB_ENDPOINT,
    payload: { method, payload },
  }
}

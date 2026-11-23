/**
 * 与上游插件的**契约常量**集中在这里。
 *
 * ## 为什么要单独一个文件
 *
 * 本仓库是「薄胶水」，全部脆弱性都来自**对上游约定的假设**。把这些假设
 * 散落在各文件里（各处零散常量），升级上游
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
 * | 只读端点 `/v1/models`、`/v1/reasoning-efforts` | `openai-gateway/server.js` 路由分发 | 这两个请求被计入「今日请求」 |
 * | 聚合 provider id `aggregate` / `jet-hub-auto` | `aggregate-adapter.ts` / `auto-adapter.ts` | 总览缓存读双计 |
 */

/** Jet Hub 管理端点路径（上游 `JET_HUB_API_PATH`）。 */
export const JET_HUB_PATH = "/api/jet-hub"

/** zcode 内部载体的载体页路径（上游 `CAPTCHA_CARRIER_PATH`，可选功能）。 */
export const CARRIER_PATH = "/api/jet-hub/captcha-carrier"

/** RPC 线协议里的端点名（上游 `JET_HUB_ENDPOINT`）。 */
export const JET_HUB_ENDPOINT = "jet-hub"

/** 客户端 bundle 会注册的 slot 名（我们据此把页面组件捞出来）。 */
export const SETTINGS_SECTION_SLOT = "settings.section"

/**
 * 只读端点（上游 `openai-gateway/server.js` 的路由分发只有这两个 GET）。
 *
 * ⚠️ 用途是**用量记账的排除表**：它们不产生 token 用量，且客户端会高频拉取
 *    （每次启动/刷新模型列表）。闸门关闭时 `/v1/models` 不走 filterModels 的
 *    提前返回，会落到反代的 tapStream —— 不排除的话每拉一次模型列表
 *    「今日请求」就 +1、成功率被 200 抬高，模型分布里还会多一条 `?`。
 */
export const READONLY_V1_PATHS = new Set(["/v1/models", "/v1/reasoning-efforts"])

/**
 * 聚合路由的 provider id（上游 `aggregate-adapter.ts` 的 `AGGREGATE_PROVIDER`
 * 与 `auto-adapter.ts` 的 `AUTO_PROVIDER`）。
 *
 * ⚠️ 用途是**去重**：上游对走聚合路由的请求会记两条 token ledger —— 一条以聚合
 *    身份（`gateway|aggregate||auto`），一条以真实渠道身份
 *    （`gateway|loomy|loomy-xxx|spark-x2.6`），同一次请求的 input/output/
 *    cacheRead/ttft 完全相同。汇总时若累加全部桶，「缓存读」会翻倍。
 *
 * ⚠️ **升级上游后要重新核对**：上游改名或新增聚合 provider 时，这里漏改会让
 *    总览静默双计。建议 grep 一次 `AGGREGATE_PROVIDER` / `AUTO_PROVIDER`。
 */
export const AGGREGATE_PROVIDERS = new Set(["aggregate", "jet-hub-auto"])

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

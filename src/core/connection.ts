/**
 * `ctx.connection` seam：Jet Hub 管理 RPC 的**唯一**接入点。
 *
 * ## 为什么只需实现 `fetch.register`
 *
 * 插件的 `registerJetHubRpc()` 是这样接进来的：
 *
 * ```ts
 * ctx.inject(['connection'], (connectionCtx) => {
 *   connection.fetch.register({ path, methods, requestBody, fetch })
 * })
 * ```
 *
 * 服务端侧只用到 `connection.fetch.register`（`rpc.call` 是**客户端**用的，
 * 宿主里没有调用方）。故这里只实现注册表，把 `path → handler` 存下来，
 * 由本仓库的 HTTP 服务原样透传请求。
 *
 * ## 为什么「原样透传」而不是自己实现一遍协议
 *
 * `register()` 拿到的 `fetch` 就是一个 `Request → Response` 函数，插件的
 * handler 内部自带完整的 RPC 信封校验（`type` / `rpcId` / `method` /
 * `payload`）与错误包装。本仓库若再包一层，两处校验必然漂移，而漂移的症状
 * 是「某个方法在这边能用、在 DSH 里不能用」。所以这里**零逻辑**：只做转发。
 */

/**
 * 创建 connection seam。
 *
 * @returns `{ service, routes, handle }`：
 *   - `service`：交给 `ctx.provide('connection', …)` 的对象；
 *   - `routes`：`path → route`，供健康检查与调试列出已挂端点；
 *   - `handle(path, request)`：把 WHATWG `Request` 交给对应 handler。
 */
export function createConnection() {
  /** path → route（`{ path, methods, requestBody, fetch }`）。 */
  const routes = new Map()

  const service = {
    fetch: {
      /**
       * 注册一条 HTTP 路由，返回 disposer（与 DSH 的契约一致）。
       *
       * 校验刻意严格：插件若改契约（比如少了 `fetch`），这里立刻抛错比
       * 静默注册一个永远不可用的端点更好排查。
       */
      register(route) {
        if (route === null || typeof route !== "object" || typeof route.path !== "string" || route.path.length === 0) {
          throw new TypeError("connection.fetch.register: route.path 必须是非空字符串")
        }
        if (typeof route.fetch !== "function") {
          throw new TypeError("connection.fetch.register: route.fetch 必须是函数")
        }
        routes.set(route.path, route)
        return () => {
          if (routes.get(route.path) === route) routes.delete(route.path)
        }
      },
    },
    // 服务端从不调用；给一个显式失败的替身，避免「以为能调」的静默 undefined。
    rpc: {
      async call() {
        throw new Error("connection.rpc.call 在本宿主中不可用（它属于 GUI 客户端侧）")
      },
    },
  }

  /**
   * 把请求转交给注册表中的 handler。
   *
   * @returns handler 的 `Response`；该 path 未注册时返回 `undefined`
   *   （由 HTTP 层决定回 404）。
   */
  async function handle(path, request) {
    const route = routes.get(path)
    if (route === undefined) return undefined
    const methods = Array.isArray(route.methods) ? route.methods : undefined
    // 分发前先按 methods 筛（与 DSH 分发器同序）：让 handler 收到的请求
    // 一定在它声明的集合内，handler 内部的 405 分支才是纯粹的防御。
    if (methods !== undefined && methods.length > 0 && !methods.includes(request.method)) {
      return new Response("method not allowed", { status: 405 })
    }
    return route.fetch(request)
  }

  return { service, routes, handle }
}

/** 网关状态与目标地址解析（服务层，供 /healthz 与 /v1 反代使用）。 */
import { JET_HUB_PATH, rpcEnvelope } from "../../core/upstream.ts"

const TARGET_TTL_MS = 5_000

/** 读网关状态；失败返回 null。 */
export async function readGatewayState(host: any) {
  try {
    const route = host.routes.get(JET_HUB_PATH)
    if (route === undefined) return null
    const web = await route.fetch(
      new Request(`http://127.0.0.1${JET_HUB_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpcEnvelope("gateway.getEnabled", {}, "healthz")),
      }),
    )
    const parsed = await web.json()
    const value = parsed?.result?.value
    if (value === undefined) return null
    return {
      enabled: value.enabled,
      running: value.running,
      blockedByEnv: value.blockedByEnv,
      address: value.address,
      modelsSource: value.modelsSource,
      modelCount: Array.isArray(value.models) ? value.models.length : 0,
    }
  } catch {
    return null
  }
}

/** 已注册的 llm provider id（读不到就空数组）。 */
export function providerIds(host: any) {
  try {
    const llm = host.ctx.get("llm")
    const listed = llm?.listProviders?.()
    return Array.isArray(listed) ? listed.map((entry: any) => entry.id) : []
  } catch {
    return []
  }
}

/** 网关目标地址（优先取上游实际监听地址，其次 DSH_OPENAI_GATEWAY_PORT/8326），带 5s 缓存。 */
export function createGatewayTargetResolver({ host }: { host: any }) {
  let cache: { at: number; host?: string; port?: number } = { at: 0 }
  return async function resolveGatewayTarget() {
    if (Date.now() - cache.at < TARGET_TTL_MS) return cache
    let resolved: { host: string; port: number }
    const state = await readGatewayState(host).catch(() => null)
    if (state?.address?.port !== undefined) {
      resolved = { host: state.address.host, port: state.address.port }
    } else {
      const raw = process.env.DSH_OPENAI_GATEWAY_PORT
      const port = raw === undefined || raw.trim() === "" ? 8326 : Number.parseInt(raw, 10)
      resolved = { host: "127.0.0.1", port: Number.isInteger(port) ? port : 8326 }
    }
    cache = { at: Date.now(), ...resolved }
    return cache
  }
}

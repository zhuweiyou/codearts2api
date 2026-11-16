/** `/v1/*` 透明反代到本机插件网关 + 网关状态查询。与路由编解耦。 */
import { Readable } from "node:stream"

import { JET_HUB_PATH, rpcEnvelope } from "../upstream.ts"
import { sendAdminJson } from "./security.ts"

/** 逐跳头：不应转发。 */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/** 网关目标地址缓存时长（网关可启停、端口可能变）。 */
const TARGET_TTL_MS = 5_000

/** 读网关状态（供 /healthz 与反代目标解析）；失败返回 null。 */
export async function readGatewayState(host) {
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
export function providerIds(host) {
  try {
    const llm = host.ctx.get("llm")
    const listed = llm?.listProviders?.()
    return Array.isArray(listed) ? listed.map((entry) => entry.id) : []
  } catch {
    return []
  }
}

/**
 * 构造 `/v1/*` 反代器。返回 `{ proxyToGateway }`。
 * 透明转发：不碰 Authorization；SSE 流式回写。
 */
export function createGatewayProxy({ host, callerGate, logger, upstreamTimeoutMs }) {
  let targetCache = { at: 0, host: undefined, port: undefined }

  async function resolveGatewayTarget() {
    if (Date.now() - targetCache.at < TARGET_TTL_MS) return targetCache
    let resolved
    const state = await readGatewayState(host).catch(() => null)
    if (state?.address?.port !== undefined) resolved = { host: state.address.host, port: state.address.port }
    else {
      const raw = process.env.DSH_OPENAI_GATEWAY_PORT
      const port = raw === undefined || raw.trim() === "" ? 8326 : Number.parseInt(raw, 10)
      resolved = { host: "127.0.0.1", port: Number.isInteger(port) ? port : 8326 }
    }
    targetCache = { at: Date.now(), ...resolved }
    return targetCache
  }

  async function proxyToGateway(request, response, url) {
    const startedAt = Date.now()
    const target = await resolveGatewayTarget()
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue
      if (Array.isArray(value)) for (const item of value) headers.append(key, item)
      else headers.set(key, value as string)
    }

    const method = request.method ?? "GET"
    const hasBody = method !== "GET" && method !== "HEAD"

    let gateEntry = null
    let gateModel
    let gateBody
    if (callerGate) {
      const verdict = await callerGate.inspect(request, url, method)
      if (!verdict.ok) {
        callerGate.sendJson(response, verdict.status ?? 403, { error: verdict.error })
        return
      }
      if (!verdict.disabled) {
        gateEntry = verdict.entry ?? null
        gateModel = verdict.model
        gateBody = verdict.body
        const upstreamKey = await callerGate.upstreamKey()
        if (upstreamKey) headers.set("authorization", `Bearer ${upstreamKey}`)
        if (gateEntry?.id) headers.set("x-caller-id", String(gateEntry.id))
      }
    }

    let upstream
    try {
      upstream = await fetch(`http://${target.host}:${target.port}${url.pathname}${url.search}`, {
        method,
        headers,
        body: gateBody ?? (hasBody ? request : undefined),
        ...(hasBody ? { duplex: "half" } : {}),
        signal: AbortSignal.timeout(upstreamTimeoutMs ?? 600_000),
      })
    } catch (error) {
      logger?.warn?.(`[proxy] 网关不可达（${target.host}:${target.port}）：${String(error)}`)
      sendAdminJson(response, 502, {
        error: {
          message: `本机网关不可达（${target.host}:${target.port}）。请在 /admin 里确认网关已开启。`,
          type: "server_error",
          code: "gateway_unreachable",
        },
      })
      return
    }

    if (callerGate && gateEntry && url.pathname === "/v1/models" && upstream.ok) {
      try {
        const payload = await upstream.json()
        callerGate.sendJson(response, 200, callerGate.filterModels(payload, gateEntry))
        return
      } catch {
        /* 解析失败就退回原始流 */
      }
    }

    const outHeaders = {}
    upstream.headers.forEach((value, key) => {
      if (HOP_BY_HOP.has(key.toLowerCase())) return
      outHeaders[key] = value
    })
    response.writeHead(upstream.status, outHeaders)

    if (upstream.body === null) {
      response.end()
      return
    }
    const stream = Readable.fromWeb(upstream.body)
    response.once("close", () => {
      if (!response.writableEnded) stream.destroy()
    })
    stream.on("error", () => response.destroy())
    const outStream = callerGate
      ? callerGate.tapStream(stream, {
          status: upstream.status,
          callerId: gateEntry?.id,
          callerName: gateEntry?.name,
          callerGroup: gateEntry?.group,
          model: gateModel,
          path: url.pathname,
          startedAt,
          stream: String(upstream.headers.get("content-type") ?? "").includes("event-stream"),
        })
      : stream
    outStream.pipe(response)
  }

  return { proxyToGateway }
}

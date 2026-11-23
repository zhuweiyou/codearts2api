/** `/v1/*` 透明反代控制器（HTTP 边界）：SSE 流式回写，鉴权交给 callerGate。 */
import { Readable } from "node:stream"

import { READONLY_V1_PATHS } from "../../core/upstream.ts"
import { sendAdminJson } from "../../http/security.ts"
import { createGatewayTargetResolver } from "./gateway.service.ts"

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

export function createGatewayController({ host, callerGate, logger, upstreamTimeoutMs }: any) {
  const resolveGatewayTarget = createGatewayTargetResolver({ host })

  async function proxyToGateway(request: any, response: any, url: any) {
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

    let gateEntry: any = null
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

    let upstream: any
    try {
      upstream = await fetch(`http://${target.host}:${target.port}${url.pathname}${url.search}`, {
        method,
        headers,
        body: gateBody ?? (hasBody ? request : undefined),
        ...(hasBody ? { duplex: "half" } : {}),
        signal: AbortSignal.timeout(upstreamTimeoutMs ?? 600_000),
      } as any)
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

    const outHeaders: any = {}
    upstream.headers.forEach((value: string, key: string) => {
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
    const outStream =
      callerGate && !READONLY_V1_PATHS.has(url.pathname)
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

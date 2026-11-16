import express from "express"

/** 模型清单控制器（/admin/models/api）：仅 HTTP 适配。 */
import { ModelsError, type ModelsService } from "./models.service.ts"

export const API_PATH = "/admin/models/api"
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
const ACTIONS = new Set(["overview", "list", "toggle", "toggleMany", "status"])

const sendJson = (response: any, status: number, body: any) => {
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(body))
}

async function readBody(request: any) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

export function createModelsController({ service, logger }: { service: ModelsService; logger?: any }) {
  async function handleApi(request: any, response: any) {
    let payload: any
    try {
      payload = await readBody(request)
    } catch (error) {
      sendJson(response, 400, { error: "请求体不是合法 JSON：" + String(error) })
      return
    }
    const action = String(payload?.action ?? "")
    if (!ACTIONS.has(action)) {
      sendJson(response, 400, { error: `未知操作 ${action || "（空）"}` })
      return
    }
    try {
      switch (action) {
        case "list":
          sendJson(response, 200, await service.list(String(payload.provider ?? "")))
          return
        case "overview":
          sendJson(response, 200, await service.overview(String(payload.provider ?? "")))
          return
        case "status": {
          const providers = Array.isArray(payload.providers)
            ? payload.providers.map((p: any) => String(p)).filter((p: string) => p.length > 0)
            : []
          if (providers.length === 0) throw new ModelsError(400, "providers 必须是非空字符串数组")
          sendJson(response, 200, await service.status(providers))
          return
        }
        case "toggle":
          sendJson(
            response,
            200,
            await service.toggle({
              provider: String(payload.provider ?? ""),
              modelId: String(payload.modelId ?? ""),
              disabled: payload.disabled,
            }),
          )
          return
        default: {
          const modelIds = Array.isArray(payload.modelIds)
            ? payload.modelIds.map((m: any) => String(m)).filter((m: string) => m.length > 0)
            : []
          sendJson(
            response,
            200,
            await service.toggleMany({
              provider: String(payload.provider ?? ""),
              modelIds,
              disabled: payload.disabled,
            }),
          )
        }
      }
    } catch (error: any) {
      const status = error instanceof ModelsError ? error.status : 500
      if (status >= 500) logger?.error?.(`[models] ${action} 失败：${String(error)}`)
      sendJson(response, status, { error: String(error?.message ?? error) })
    }
  }

  const router = express.Router()
  router.all(API_PATH, (request: any, response: any, next: any) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "只支持 POST" })
      return
    }
    handleApi(request, response).catch(next)
  })

  return { router }
}

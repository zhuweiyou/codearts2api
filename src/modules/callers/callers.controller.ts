import express from "express"

/**
 * 调用方管理控制器（`/admin/callers/api`）：只做 HTTP 适配 —— 解析 action/body、调用 service、写响应。
 * 业务全部在 {@link createCallersService}。
 */
import { CallerAdminError, type CallersService } from "./callers.service.ts"

export const API_PATH = "/admin/callers/api"

const BODY_LIMIT = 1 << 20

function sendJson(response: any, status: number, payload: any) {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  })
  response.end(body)
}

async function readJson(request: any, limit = BODY_LIMIT) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error("请求体过大")
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

export function createCallersController({ service, logger }: { service: CallersService; logger?: any }) {
  async function handleApi(request: any, response: any) {
    let payload: any
    try {
      payload = await readJson(request)
    } catch (error) {
      sendJson(response, 400, { error: `请求体无法解析：${String(error)}` })
      return
    }
    const action = String(payload.action ?? "")
    try {
      switch (action) {
        case "state":
          sendJson(response, 200, await service.state(payload.day))
          return
        case "records":
          sendJson(
            response,
            200,
            await service.records({ days: payload.days, filter: payload.filter, limit: payload.limit }),
          )
          return
        case "key.add":
          sendJson(
            response,
            200,
            await service.addKey({ name: payload.name, group: payload.group, enabled: payload.enabled }),
          )
          return
        case "key.update":
          sendJson(
            response,
            200,
            await service.updateKey({
              id: payload.id,
              name: payload.name,
              group: payload.group,
              enabled: payload.enabled,
            }),
          )
          return
        case "key.rm":
          sendJson(response, 200, await service.removeKey(String(payload.id ?? "")))
          return
        case "group.save":
          sendJson(
            response,
            200,
            await service.saveGroup({ name: payload.name, desc: payload.desc, allow: payload.allow }),
          )
          return
        case "group.rm":
          sendJson(response, 200, await service.removeGroup(String(payload.name ?? "")))
          return
        default:
          sendJson(response, 400, { error: `未知操作 ${action || "（空）"}` })
          return
      }
    } catch (error: any) {
      const status = error instanceof CallerAdminError ? error.status : 500
      if (status >= 500) logger?.error?.(`[callers] ${action} 失败：${String(error)}`)
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

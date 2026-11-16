/** 调用方管理 REST 控制器（挂在 /admin/callers/api 下）。业务全在 {@link CallersService}。 */
import express from "express"

import { sendJson } from "../../http/respond.ts"
import { CallerAdminError, type CallersService } from "./callers.service.ts"

export function createCallersController({ service }: { service: CallersService }) {
  const router = express.Router()
  router.use(express.json({ limit: "1mb", type: () => true }))

  /**
   * 兼容旧版 `POST /admin/callers/api` 的 `{ action, ...payload }` 协议。
   * 新前端已改走下面的 REST 路由；这里保留一个迁移窗口，避免外部脚本直接失效。
   */
  router.post("/", async (request, response) => {
    const body = request.body ?? {}
    const action = String(body.action ?? "")
    switch (action) {
      case "state":
        sendJson(response, 200, await service.state(typeof body.day === "string" ? body.day : undefined))
        return
      case "records":
        sendJson(
          response,
          200,
          await service.records({
            days: Array.isArray(body.days) ? body.days : [],
            filter: body.filter,
            limit: body.limit,
          }),
        )
        return
      case "key.add":
        sendJson(response, 200, await service.addKey({ name: body.name, group: body.group, enabled: body.enabled }))
        return
      case "key.update":
        sendJson(
          response,
          200,
          await service.updateKey({ id: body.id, name: body.name, group: body.group, enabled: body.enabled }),
        )
        return
      case "key.rm":
        sendJson(response, 200, await service.removeKey(body.id))
        return
      case "group.save":
        sendJson(response, 200, await service.saveGroup({ name: body.name, desc: body.desc, allow: body.allow }))
        return
      case "group.rm":
        sendJson(response, 200, await service.removeGroup(body.name))
        return
      default:
        throw new CallerAdminError(400, `未知操作 ${action || "（空）"}`)
    }
  })

  router.get("/state", async (request, response) => {
    const rawDay = typeof request.query.day === "string" ? request.query.day : ""
    const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : undefined
    sendJson(response, 200, await service.state(day))
  })

  router.get("/records", async (request, response) => {
    const days = typeof request.query.days === "string" && request.query.days ? request.query.days.split(",") : []
    const filter = {
      caller: String(request.query.caller ?? ""),
      model: String(request.query.model ?? ""),
      status: String(request.query.status ?? ""),
    }
    const limit = Number(request.query.limit ?? 300)
    sendJson(response, 200, await service.records({ days, filter, limit }))
  })

  router.post("/groups", async (request, response) => {
    const body = request.body ?? {}
    sendJson(response, 200, await service.saveGroup({ name: body.name, desc: body.desc, allow: body.allow }))
  })

  router.delete("/groups/:name", async (request, response) => {
    sendJson(response, 200, await service.removeGroup(request.params.name))
  })

  router.post("/keys", async (request, response) => {
    const body = request.body ?? {}
    sendJson(response, 200, await service.addKey({ name: body.name, group: body.group, enabled: body.enabled }))
  })

  router.patch("/keys/:id", async (request, response) => {
    const body = request.body ?? {}
    sendJson(
      response,
      200,
      await service.updateKey({ id: request.params.id, name: body.name, group: body.group, enabled: body.enabled }),
    )
  })

  router.delete("/keys/:id", async (request, response) => {
    sendJson(response, 200, await service.removeKey(request.params.id))
  })

  return { router }
}

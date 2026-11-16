/** 调用方管理 REST 控制器（挂在 /admin/callers/api 下）。业务全在 {@link CallersService}。 */
import express from "express"

import { readJsonBody, sendJson } from "../../http/respond.ts"
import type { CallersService } from "./callers.service.ts"

export function createCallersController({ service }: { service: CallersService }) {
  const router = express.Router()

  router.get("/state", async (request, response) => {
    const day = typeof request.query.day === "string" ? request.query.day : undefined
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
    const body = await readJsonBody(request)
    sendJson(response, 200, await service.saveGroup({ name: body.name, desc: body.desc, allow: body.allow }))
  })

  router.delete("/groups/:name", async (request, response) => {
    sendJson(response, 200, await service.removeGroup(request.params.name))
  })

  router.post("/keys", async (request, response) => {
    const body = await readJsonBody(request)
    sendJson(response, 200, await service.addKey({ name: body.name, group: body.group, enabled: body.enabled }))
  })

  router.patch("/keys/:id", async (request, response) => {
    const body = await readJsonBody(request)
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

/**
 * 调用方管理控制器（`/admin/callers/api`）：单端点 RPC，按 `action` 用表驱动分发到 service。
 * 只做 HTTP 适配；业务全在 {@link CallersService}。
 */
import express from "express"

import { readJsonBody, sendJson } from "../../http/respond.ts"
import type { CallersService } from "./callers.service.ts"

export const API_PATH = "/admin/callers/api"

export function createCallersController({ service }: { service: CallersService }) {
  const actions: Record<string, (payload: any) => Promise<any>> = {
    state: (p) => service.state(p.day),
    records: (p) => service.records({ days: p.days, filter: p.filter, limit: p.limit }),
    "key.add": (p) => service.addKey({ name: p.name, group: p.group, enabled: p.enabled }),
    "key.update": (p) => service.updateKey({ id: p.id, name: p.name, group: p.group, enabled: p.enabled }),
    "key.rm": (p) => service.removeKey(String(p.id ?? "")),
    "group.save": (p) => service.saveGroup({ name: p.name, desc: p.desc, allow: p.allow }),
    "group.rm": (p) => service.removeGroup(String(p.name ?? "")),
  }

  const router = express.Router()
  router.all(API_PATH, async (request, response) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "只支持 POST" })
      return
    }
    const payload = await readJsonBody(request)
    const action = String(payload.action ?? "")
    const run = actions[action]
    if (!run) {
      sendJson(response, 400, { error: `未知操作 ${action || "（空）"}` })
      return
    }
    sendJson(response, 200, await run(payload))
  })

  return { router }
}

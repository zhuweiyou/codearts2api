/** 模型清单控制器（/admin/models/api）：单端点 RPC，按 action 表驱动分发。 */
import express from "express"

import { AppError } from "../../core/errors.ts"
import { readJsonBody, sendJson } from "../../http/respond.ts"
import type { ModelsService } from "./models.service.ts"

export const API_PATH = "/admin/models/api"

export function createModelsController({ service }: { service: ModelsService }) {
  const actions: Record<string, (payload: any) => Promise<any>> = {
    list: (p) => service.list(String(p.provider ?? "")),
    overview: (p) => service.overview(String(p.provider ?? "")),
    status: (p) => {
      const providers = Array.isArray(p.providers)
        ? p.providers.map((x: any) => String(x)).filter((x: string) => x.length > 0)
        : []
      if (providers.length === 0) throw new AppError(400, "invalid_providers", "providers 必须是非空字符串数组")
      return service.status(providers)
    },
    toggle: (p) =>
      service.toggle({ provider: String(p.provider ?? ""), modelId: String(p.modelId ?? ""), disabled: p.disabled }),
    toggleMany: (p) => {
      const modelIds = Array.isArray(p.modelIds)
        ? p.modelIds.map((x: any) => String(x)).filter((x: string) => x.length > 0)
        : []
      return service.toggleMany({ provider: String(p.provider ?? ""), modelIds, disabled: p.disabled })
    },
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

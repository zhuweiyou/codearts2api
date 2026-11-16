/** 模型清单 REST 控制器（挂在 /admin/models/api 下）。业务在 {@link ModelsService}。 */
import express from "express"

import { AppError } from "../../core/errors.ts"
import { sendJson } from "../../http/respond.ts"
import { ModelsError, type ModelsService } from "./models.service.ts"

export function createModelsController({ service }: { service: ModelsService }) {
  const router = express.Router()
  router.use(express.json({ limit: "1mb", type: () => true }))

  /**
   * 兼容旧版 `POST /admin/models/api` 的 `{ action, ...payload }` 协议。
   * 新前端已改走下面的 REST 路由；这里保留一个迁移窗口，避免外部脚本直接失效。
   */
  router.post("/", async (request, response) => {
    const body = request.body ?? {}
    const action = String(body.action ?? "")
    switch (action) {
      case "list":
      case "overview": {
        const provider = String(body.provider ?? "")
        if (!provider) throw new ModelsError(400, "provider 必填")
        sendJson(response, 200, action === "list" ? await service.list(provider) : await service.overview(provider))
        return
      }
      case "status": {
        const providers = Array.isArray(body.providers)
          ? body.providers.map((value: any) => String(value)).filter(Boolean)
          : []
        if (providers.length === 0) throw new ModelsError(400, "providers 必须是非空字符串数组")
        sendJson(response, 200, await service.status(providers))
        return
      }
      case "toggle":
        sendJson(
          response,
          200,
          await service.toggle({ provider: body.provider, modelId: body.modelId, disabled: body.disabled }),
        )
        return
      case "toggleMany":
        sendJson(
          response,
          200,
          await service.toggleMany({ provider: body.provider, modelIds: body.modelIds, disabled: body.disabled }),
        )
        return
      default:
        throw new ModelsError(400, `未知操作 ${action || "（空）"}`)
    }
  })

  router.get("/status", async (request, response) => {
    const providers = String(request.query.providers ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
    if (providers.length === 0) throw new AppError(400, "invalid_providers", "providers 必须是非空字符串数组")
    sendJson(response, 200, await service.status(providers))
  })

  router.get("/:provider", async (request, response) => {
    const provider = request.params.provider
    sendJson(
      response,
      200,
      request.query.plain === "1" ? await service.list(provider) : await service.overview(provider),
    )
  })

  router.patch("/:provider/models/:modelId", async (request, response) => {
    const body = request.body ?? {}
    sendJson(
      response,
      200,
      await service.toggle({
        provider: request.params.provider,
        modelId: request.params.modelId,
        disabled: body.disabled,
      }),
    )
  })

  router.patch("/:provider/models", async (request, response) => {
    const body = request.body ?? {}
    const modelIds = Array.isArray(body.modelIds) ? body.modelIds.map((m: any) => String(m)).filter(Boolean) : []
    sendJson(
      response,
      200,
      await service.toggleMany({ provider: request.params.provider, modelIds, disabled: body.disabled }),
    )
  })

  return { router }
}

/** 模型清单 REST 控制器（挂在 /admin/models/api 下）。业务在 {@link ModelsService}。 */
import express from "express"

import { AppError } from "../../core/errors.ts"
import { readJsonBody, sendJson } from "../../http/respond.ts"
import type { ModelsService } from "./models.service.ts"

export function createModelsController({ service }: { service: ModelsService }) {
  const router = express.Router()

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
    const body = await readJsonBody(request)
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
    const body = await readJsonBody(request)
    const modelIds = Array.isArray(body.modelIds) ? body.modelIds.map((m: any) => String(m)).filter(Boolean) : []
    sendJson(
      response,
      200,
      await service.toggleMany({ provider: request.params.provider, modelIds, disabled: body.disabled }),
    )
  })

  return { router }
}

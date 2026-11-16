/** 模型清单 REST 控制器。业务在 {@link ModelsService}。 */
import express from "express"

import { AppError } from "../../core/errors.ts"
import { readJsonBody, sendJson } from "../../http/respond.ts"
import type { ModelsService } from "./models.service.ts"

export const MODELS_API_PREFIX = "/admin/models/api"

export function createModelsController({ service }: { service: ModelsService }) {
  const router = express.Router()

  router.get(`${MODELS_API_PREFIX}/status`, async (request, response) => {
    const providers = String(request.query.providers ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
    if (providers.length === 0) throw new AppError(400, "invalid_providers", "providers 必须是非空字符串数组")
    sendJson(response, 200, await service.status(providers))
  })

  router.get(`${MODELS_API_PREFIX}/:provider`, async (request, response) => {
    const provider = request.params.provider
    if (request.query.plain === "1") {
      sendJson(response, 200, await service.list(provider))
      return
    }
    sendJson(response, 200, await service.overview(provider))
  })

  router.patch(`${MODELS_API_PREFIX}/:provider/models/:modelId`, async (request, response) => {
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

  router.patch(`${MODELS_API_PREFIX}/:provider/models`, async (request, response) => {
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

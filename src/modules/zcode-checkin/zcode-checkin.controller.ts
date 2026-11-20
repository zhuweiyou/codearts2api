/** ZCode 自动签到控制器（挂在 /admin/zcode-checkin/api 下）。业务全在 service。 */
import express from "express"

import { sendJson } from "../../http/respond.ts"
import type { ZcodeCheckin } from "./zcode-checkin.service.ts"

export function createZcodeCheckinController({ service }: { service: ZcodeCheckin }) {
  const router = express.Router()
  router.use(express.json({ limit: "16kb", type: () => true }))

  router.get("/state", async (_request, response) => {
    sendJson(response, 200, await service.state())
  })

  router.post("/enabled", async (request, response) => {
    const enabled = request.body?.enabled
    if (typeof enabled !== "boolean") {
      sendJson(response, 400, { error: "enabled 必须是布尔值" })
      return
    }
    try {
      sendJson(response, 200, await service.setEnabled(enabled))
    } catch (error) {
      // env 强制关闭：与网关开关同族，回 409 让前端把开关置灰并展示原因。
      sendJson(response, 409, { error: String(error instanceof Error ? error.message : error) })
    }
  })

  return { router }
}

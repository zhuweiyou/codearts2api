/** 总览看板控制器（挂在 /admin/dashboard/api 下）。 */
import express from "express"

import { sendJson } from "../../http/respond.ts"
import { createDashboard } from "./dashboard.service.ts"

export function createDashboardController(options: any) {
  const dashboard = createDashboard(options)
  const router = express.Router()

  router.all("/", async (request, response) => {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method Not Allowed" })
      return
    }
    try {
      const fresh = request.query.fresh === "1"
      sendJson(response, 200, await dashboard.snapshot({ fresh }))
    } catch (error) {
      options.logger?.error?.("[dashboard] snapshot failed: " + String(error))
      sendJson(response, 500, { error: String(error) })
    }
  })

  return { router }
}

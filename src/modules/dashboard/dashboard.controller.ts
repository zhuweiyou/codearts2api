import express from "express"

import { createDashboard } from "./dashboard.service.ts"

export const API_PATH = "/admin/dashboard/api"

/** HTTP 挂载：GET /admin/dashboard/api（?fresh=1 强制刷新余额缓存）。 */
export function createDashboardController(options: any) {
  const dashboard = createDashboard(options)
  async function handle(request: any, response: any, url: any) {
    if (url.pathname !== API_PATH) return false
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "application/json; charset=utf-8" })
      response.end(JSON.stringify({ error: "Method Not Allowed" }))
      return true
    }
    try {
      const fresh = url.searchParams.get("fresh") === "1"
      const data = await dashboard.snapshot({ fresh })
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
      response.end(JSON.stringify(data))
    } catch (error) {
      options.logger?.error?.("[dashboard] snapshot failed: " + String(error))
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" })
      response.end(JSON.stringify({ error: String(error) }))
    }
    return true
  }

  const router = express.Router()
  router.all(API_PATH, (request: any, response: any, next: any) => {
    const url = new URL(request.originalUrl ?? request.url ?? "/", "http://127.0.0.1")
    handle(request, response, url).catch(next)
  })

  return { router }
}

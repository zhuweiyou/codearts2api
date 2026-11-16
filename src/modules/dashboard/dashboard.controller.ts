import { createDashboard } from "./dashboard.service.ts"

export const API_PATH = "/admin/dashboard/api"

/** HTTP 挂载：GET /admin/dashboard/api（?fresh=1 强制刷新余额缓存）。 */
export function createDashboardController(options: any) {
  const dashboard = createDashboard(options)
  return {
    async handle(request, response, url) {
      if (url.pathname === API_PATH) {
        if (request.method !== "GET") {
          response.writeHead(405, { "content-type": "application/json; charset=utf-8" })
          response.end(JSON.stringify({ error: "Method Not Allowed" }))
          return true
        }
        try {
          const fresh = url.searchParams.get("fresh") === "1"
          const data = await dashboard.snapshot({ fresh })
          response.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          })
          response.end(JSON.stringify(data))
        } catch (error) {
          options.logger?.error?.("[dashboard] snapshot failed: " + String(error))
          response.writeHead(500, { "content-type": "application/json; charset=utf-8" })
          response.end(JSON.stringify({ error: String(error) }))
        }
        return true
      }

      return false
    },
  }
}

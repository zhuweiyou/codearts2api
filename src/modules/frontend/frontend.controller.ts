/** 前端产物服务（dist/）：`/admin/assets/*` 静态资产 + `/admin/*` SPA 回退到 index.html。 */
import { readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { CONTENT_TYPES, sendAdmin, sendAdminJson } from "../../http/security.ts"

const here = fileURLToPath(new URL(".", import.meta.url))
/** 仓库根 dist/（src 下与 dist-server 下相对层级一致：../../../dist）。 */
const DIST_DIR = join(here, "..", "..", "..", "dist")
const ASSET_PREFIX = "/admin/assets/"
const API_PATH = /^\/(?:api(?:\/|$)|relay(?:\/|$)|admin\/(?:[^/]+\/)*api(?:\/|$)|admin\/oauth-relay(?:\/|$))/

/**
 * 尝试用 dist 响应前端请求；命中返回 true，否则 false。
 * - `/admin/assets/<file>` → dist/assets/<file>（文件名白名单，禁止穿越）；
 * - `/admin`、`/admin/`、`/admin/*`（GET/HEAD）→ dist/index.html（SPA 回退）。
 */
export async function serveFrontend(request, response, path) {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  // API 路径绝不回退到 SPA HTML（未知接口应 404 JSON，而不是 200 页面）
  if (API_PATH.test(path)) return false

  if (path.startsWith(ASSET_PREFIX)) {
    const name = path.slice(ASSET_PREFIX.length)
    if (name === "" || name.includes("/") || name.includes("\\") || name.includes("..")) {
      sendAdminJson(response, 404, { error: "not found" })
      return true
    }
    const target = join(DIST_DIR, "assets", name)
    try {
      const body = await readFile(target)
      sendAdmin(response, 200, body, { "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream" })
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      sendAdmin(response, 404, "asset not found", { "content-type": "text/plain; charset=utf-8" })
    }
    return true
  }

  const isSpaRoute = path === "/admin" || path === "/admin/" || path.startsWith("/admin/")
  if (isSpaRoute) {
    const target = join(DIST_DIR, "index.html")
    let body
    try {
      body = await readFile(target)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      sendAdmin(response, 503, "管理界面尚未构建：请先执行 vp build（或 pnpm run build）", {
        "content-type": "text/plain; charset=utf-8",
      })
      return true
    }
    sendAdmin(response, 200, body, { "content-type": "text/html; charset=utf-8" })
    return true
  }

  return false
}

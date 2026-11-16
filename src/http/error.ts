/** 统一错误处理中间件：AppError → 对应状态；其它 → 500。响应保持 { error: "<message>" }。 */
import { isAppError } from "../core/errors.ts"
import { sendJson } from "./respond.ts"

export function createErrorHandler(logger?: any) {
  return (error: any, _request: any, response: any, _next: any) => {
    const status = isAppError(error) ? error.status : 500
    if (status >= 500) logger?.error?.(`[http] 处理失败：${String(error)}`)
    if (response.headersSent) {
      response.end()
      return
    }
    sendJson(response, status, { error: String(error?.message ?? error) })
  }
}

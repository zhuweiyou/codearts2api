/** 统一错误处理中间件：AppError → 对应状态；其它 → 500。响应保持 { error: "<message>" }。 */
import { isAppError } from "../core/errors.ts"
import { sendAdminJson } from "./security.ts"

export function createErrorHandler(logger?: any) {
  return (error: any, request: any, response: any, _next: any) => {
    const rawStatus = Number(error?.status ?? error?.statusCode)
    const status = isAppError(error) ? error.status : rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500
    if (status >= 500)
      logger?.error?.(
        `[http] ${request?.method ?? ""} ${request?.originalUrl ?? request?.url ?? ""} 处理失败：${String(error)}`,
      )
    if (response.headersSent) {
      response.end()
      return
    }
    sendAdminJson(response, status, { error: String(error?.message ?? error) })
  }
}

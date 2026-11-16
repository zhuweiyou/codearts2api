/** 领域错误：带 HTTP 状态码，供统一错误中间件转成响应。 */
export class AppError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "AppError"
    this.status = status
    this.code = code
  }
}

export function isAppError(error: any): error is AppError {
  return error instanceof AppError
}

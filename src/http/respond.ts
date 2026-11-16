/** 统一的 JSON 响应与请求体读取（控制器共用）。 */
import { AppError } from "../core/errors.ts"

export function sendJson(response: any, status: number, payload: any) {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  })
  response.end(body)
}

export async function readJsonBody(request: any, limit = 1 << 20): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new AppError(413, "body_too_large", "请求体过大")
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch (error) {
    throw new AppError(400, "invalid_body", `请求体无法解析：${String(error)}`)
  }
}

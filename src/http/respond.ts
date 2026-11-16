/** 统一的 JSON 响应与请求体读取（控制器共用）。响应统一带安全头。 */
import { sendAdminJson } from "./security.ts"

export function sendJson(response: any, status: number, payload: any) {
  sendAdminJson(response, status, payload)
}

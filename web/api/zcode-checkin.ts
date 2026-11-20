/** ZCode 自动签到 REST 接口（/admin/zcode-checkin/api）。 */
const API = "/admin/zcode-checkin/api"

async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data && (data as any).error) || "HTTP " + res.status)
  return data as T
}

export const getZcodeCheckinState = () => request("/state")

export const setZcodeCheckinEnabled = (enabled: boolean) =>
  request("/enabled", { method: "POST", body: JSON.stringify({ enabled }) })

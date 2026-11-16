/** 管理端会话/登录 API（后端只处理凭据，登录 UI 在前端）。 */

export interface SessionInfo {
  authenticated: boolean
}

export async function getSession(): Promise<SessionInfo> {
  try {
    const response = await fetch("/admin/api/session", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
    if (!response.ok) return { authenticated: false }
    return (await response.json()) as SessionInfo
  } catch {
    return { authenticated: false }
  }
}

export async function login(key: string, next: string): Promise<{ ok: boolean; next?: string }> {
  const response = await fetch("/admin/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ key, next }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || "HTTP " + response.status)
  return data
}

export async function logout(): Promise<void> {
  await fetch("/admin/logout", { method: "POST", credentials: "same-origin" }).catch(() => {})
}

export type OAuthReplayResult = {
  ok: boolean
  status?: number
  port?: number
  target?: string
  snippet?: string
  error?: string
}

/** 把浏览器里失败的 OAuth 回调地址交给服务器本机重放一次（POST /admin/oauth-relay/replay）。 */
export async function replayOAuthCallback(url: string): Promise<OAuthReplayResult> {
  const response = await fetch("/admin/oauth-relay/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  })
  let data: any = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok) {
    const message = data && (data.error || data.message)
    throw new Error(message || `重放失败（HTTP ${response.status}）`)
  }
  return (data || { ok: false }) as OAuthReplayResult
}

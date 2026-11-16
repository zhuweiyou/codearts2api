/**
 * Jet Hub RPC 封装（自 web/admin.jsx 迁移，协议不变）：
 * 以 `{ method, payload }` 信封 POST `/api/jet-hub`，响应 `{ type, rpcId, result }`，
 * `result = { ok:true, value }` 或 `{ ok:false, error }`。ok 为假时抛带 code 的 Error。
 */
export async function rpcCall(method: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch("/api/jet-hub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
      method: "jet-hub",
      payload: { method, payload },
    }),
    signal,
  })
  if (!response.ok) throw new Error(`管理接口返回 HTTP ${response.status}`)
  const body: any = await response.json()
  const result = body?.result
  if (result?.ok === true) return result.value
  if (result?.ok === false) {
    const error: any = new Error(result.error?.message ?? "Jet Hub 请求失败")
    error.code = result.error?.code
    throw error
  }
  throw new Error("管理接口返回了无法识别的响应")
}

let proxyGatewayPromise: Promise<boolean> | null = null
function proxyGatewayEnabled(): Promise<boolean> {
  if (proxyGatewayPromise === null) {
    proxyGatewayPromise = fetch("/healthz", { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: any) => data?.proxyGateway === true)
      .catch(() => false)
  }
  return proxyGatewayPromise
}

/** 包一层：网关开启且上游未给 publicUrl 时，补成 `location.origin + /v1`。 */
export async function hostRpcCall(method: string, payload?: unknown, signal?: AbortSignal): Promise<any> {
  const value: any = await rpcCall(method, payload, signal)
  if (
    method === "gateway.getEnabled" &&
    value !== null &&
    typeof value === "object" &&
    !(typeof value.publicUrl === "string" && value.publicUrl.trim() !== "") &&
    (await proxyGatewayEnabled())
  ) {
    return { ...value, publicUrl: `${window.location.origin}/v1` }
  }
  return value
}

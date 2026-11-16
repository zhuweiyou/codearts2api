/** 调用方后端 REST 接口（/admin/callers/api）。 */
const API = "/admin/callers/api"

export interface Group {
  name: string
  desc?: string
  allow?: string[]
}
export interface KeyRow {
  id: string
  name: string
  group: string
  enabled: boolean
  sha: string
  createdAt?: string
}
export interface CallerState {
  groups: Group[]
  keys: KeyRow[]
  usage: { day: string; rows: any[] }
  storePath?: string
}
export interface RecordsQuery {
  days: string[]
  filter: { caller: string; model: string; status: string }
}
export interface RecordsResult {
  days?: string[]
  availableDays?: string[]
  total?: number
  shown?: number
  byModel?: any[]
  rows?: any[]
}

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

export const getState = () => request<CallerState>("/state")

export const getRecords = (q: RecordsQuery) => {
  const params = new URLSearchParams()
  params.set("days", q.days.join(","))
  params.set("caller", q.filter.caller)
  params.set("model", q.filter.model)
  params.set("status", q.filter.status)
  params.set("limit", "300")
  return request<RecordsResult>("/records?" + params.toString())
}

export const saveGroup = (name: string, desc: string, allow: string[]) =>
  request("/groups", { method: "POST", body: JSON.stringify({ name, desc, allow }) })

export const removeGroup = (name: string) => request(`/groups/${encodeURIComponent(name)}`, { method: "DELETE" })

export const addKey = (input: { name: string; group: string; enabled: boolean }) =>
  request("/keys", { method: "POST", body: JSON.stringify(input) })

export const updateKey = (input: { id: string; name: string; group: string; enabled: boolean }) => {
  const { id, ...rest } = input
  return request(`/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(rest) })
}

export const removeKey = (id: string) => request(`/keys/${encodeURIComponent(id)}`, { method: "DELETE" })

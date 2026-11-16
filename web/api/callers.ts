/** 调用方后端接口（/admin/callers/api）。入参契约：顶层扁平字段。 */
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

async function post<T = any>(payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data && (data as any).error) || "HTTP " + res.status)
  return data as T
}

export const callersApi = post
export const getState = () => post<CallerState>({ action: "state" })
export const getRecords = (q: RecordsQuery) =>
  post<RecordsResult>({ action: "records", days: q.days, filter: q.filter, limit: 300 })
export const saveGroup = (name: string, desc: string, allow: string[]) =>
  post({ action: "group.save", name, desc, allow })
export const removeGroup = (name: string) => post({ action: "group.rm", name })
export const addKey = (input: { name: string; group: string; enabled: boolean }) =>
  post({ action: "key.add", ...input })
export const updateKey = (input: { id: string; name: string; group: string; enabled: boolean }) =>
  post({ action: "key.update", ...input })
export const removeKey = (id: string) => post({ action: "key.rm", id })

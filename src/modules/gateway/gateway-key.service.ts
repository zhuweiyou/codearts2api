/** 上游网关 Key 读取（带 5s 短缓存）：用户可在 /admin 重置 key，热路径又不能每次读盘。 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export function createUpstreamKeyReader({ home }: { home: string }) {
  const cache: { value: string | null; until: number } = { value: null, until: 0 }
  return async function readUpstreamKey(): Promise<string | null> {
    const fromEnv = process.env.DSH_OPENAI_GATEWAY_API_KEY
    if (fromEnv && fromEnv.trim()) return fromEnv.trim()
    if (cache.value !== null && Date.now() < cache.until) return cache.value
    try {
      const value = (await readFile(join(home, "openai-gateway", "api-key"), "utf8")).trim()
      if (!value) return null
      cache.value = value
      cache.until = Date.now() + 5_000
      return value
    } catch {
      cache.value = null
      cache.until = 0
      return null
    }
  }
}

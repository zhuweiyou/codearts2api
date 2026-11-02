// probe-aggregate.mjs —— 给聚合目录里每个 aggregate/* 模型发一次最小请求，记录「正常/异常」。
// 只在服务器本机跑（回环 18080 + 上游 key），不经过公网。
import { readFileSync, writeFileSync } from "node:fs"

const HOME = "/www/wwwroot/api.321ds.cn"
const BASE = "http://127.0.0.1:18080"
const KEY = readFileSync(`${HOME}/data/openai-gateway/api-key`, "utf8").trim()
const CONCURRENCY = 4
const TIMEOUT_MS = 90_000
const PROMPT = "只回答两个字：收到"

const out = { at: new Date().toISOString(), ok: 0, fail: 0, models: [] }

async function list() {
  const r = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } })
  if (!r.ok) throw new Error(`models ${r.status}`)
  const j = await r.json()
  return (j.data || []).map((m) => m.id).filter((id) => id.startsWith("aggregate/"))
}

async function probe(model) {
  const started = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: PROMPT }], max_tokens: 16 }),
      signal: ac.signal,
    })
    const ms = Date.now() - started
    const text = await r.text()
    if (!r.ok) {
      let msg = text.slice(0, 200)
      try {
        msg = JSON.parse(text)?.error?.message ?? msg
      } catch {
        /* keep raw */
      }
      return { model, status: "fail", code: r.status, ms, error: msg }
    }
    let body = {}
    try {
      body = JSON.parse(text)
    } catch {
      /* ignore */
    }
    const content = body?.choices?.[0]?.message?.content ?? ""
    const usage = body?.usage ?? {}
    return {
      model,
      status: content.trim() ? "ok" : "empty",
      ms,
      reply: content.slice(0, 40),
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
    }
  } catch (err) {
    return { model, status: "fail", ms: Date.now() - started, error: String(err?.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

const ids = await list()
console.error(`待探测 ${ids.length} 个 aggregate 模型，并发 ${CONCURRENCY}`)

const queue = [...ids]
const results = []
async function worker() {
  while (queue.length) {
    const model = queue.shift()
    const r = await probe(model)
    results.push(r)
    console.error(`[${results.length}/${ids.length}] ${r.status.padEnd(5)} ${model} ${r.ms}ms`)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)))

results.sort((a, b) => (a.model < b.model ? -1 : 1))
out.models = results
out.ok = results.filter((r) => r.status === "ok").length
out.fail = results.filter((r) => r.status !== "ok").length
writeFileSync("/tmp/aggregate-health.json", JSON.stringify(out, null, 2))
console.error(`DONE ok=${out.ok} fail=${out.fail}`)
process.exit(0)

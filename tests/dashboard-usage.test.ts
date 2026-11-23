import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { test } from "vite-plus/test"

import { utc8Day } from "../src/core/day.ts"
import { createDashboard } from "../src/modules/dashboard/dashboard.service.ts"

test("总览 ledger：聚合层与真实渠道层是同一笔请求，缓存读不能双计", async () => {
  const home = await mkdtemp(join(tmpdir(), "c2a-dashboard-"))
  const today = utc8Day()
  try {
    await mkdir(join(home, "jet-hub"), { recursive: true })
    await writeFile(
      join(home, "jet-hub", "token-ledger.json"),
      JSON.stringify({
        days: {
          [today]: {
            // 同一笔聚合请求的两条记录（上游按聚合身份与真实渠道身份各记一次）
            "gateway|aggregate||auto": {
              requests: 1,
              inputTokens: 24,
              outputTokens: 131,
              cacheReadTokens: 500,
              ttftSumMs: 1200,
              ttftCount: 1,
            },
            "gateway|loomy|acc-1|spark-x2.6": {
              requests: 1,
              inputTokens: 24,
              outputTokens: 131,
              cacheReadTokens: 500,
              ttftSumMs: 1200,
              ttftCount: 1,
            },
            "gateway|jet-hub-auto||auto": {
              requests: 1,
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              ttftSumMs: 800,
              ttftCount: 1,
            },
            // 普通（非聚合）渠道调用：必须照常统计
            "gateway|codearts|acc-2|gmodel": {
              requests: 2,
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 100,
              ttftSumMs: 400,
              ttftCount: 2,
            },
          },
        },
      }),
      "utf8",
    )

    const dashboard = createDashboard({ dataDir: home, rpc: async () => ({}), gateway: () => ({}) })
    const snapshot = await dashboard.snapshot()
    const day = snapshot.ledger.find((x: any) => x.date === today)
    assert.ok(day, "今天的 ledger 条目应存在")
    // 500（loomy）+ 100（codearts）；聚合层那 500 与 jet-hub-auto 不能算第二遍
    assert.equal(day.cacheRead, 600)
    assert.equal(day.requests, 3)
    assert.equal(day.ttftAvgMs, Math.round((1200 + 400) / 3))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

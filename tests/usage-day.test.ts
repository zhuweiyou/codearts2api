import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { test, vi } from "vite-plus/test"

import { utc8Day } from "../src/core/day.ts"
import { createUsageRecorder } from "../src/modules/caller-gate/usage-recorder.service.ts"
import { createCallersService } from "../src/modules/callers/callers.service.ts"

test("utc8Day：跨 UTC 日界（北京 00:00-08:00）仍取北京当天", () => {
  // UTC 2026-11-22 23:30 = 北京 2026-11-23 07:30
  assert.equal(utc8Day(new Date("2026-11-22T23:30:00Z")), "2026-11-23")
  // UTC 2026-11-23 15:59 = 北京 23:59
  assert.equal(utc8Day(new Date("2026-11-23T15:59:00Z")), "2026-11-23")
  // UTC 2026-11-23 16:00 = 北京次日 00:00
  assert.equal(utc8Day(new Date("2026-11-23T16:00:00Z")), "2026-11-24")
})

test("用量日志与调用方页都按 UTC+8 日键（UTC 机器上北京凌晨不写前一天）", async () => {
  const home = await mkdtemp(join(tmpdir(), "c2a-usage-day-"))
  try {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-22T23:30:00Z")) // 北京 11-23 07:30
    const recorder = createUsageRecorder({ logDir: join(home, "caller-usage") })
    await recorder.log({ ts: new Date().toISOString(), status: 200, in_tokens: 1, out_tokens: 1 })

    assert.ok(existsSync(join(home, "caller-usage", "2026-11-23.jsonl")))
    assert.ok(!existsSync(join(home, "caller-usage", "2026-11-22.jsonl")))

    const state = await createCallersService({ home }).state()
    assert.equal(state.usage.day, "2026-11-23")
    assert.equal(state.usage.rows.length, 1)
  } finally {
    vi.useRealTimers()
    await rm(home, { recursive: true, force: true })
  }
})

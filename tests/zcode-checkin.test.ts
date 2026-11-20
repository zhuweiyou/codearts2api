/**
 * ZCode 自动签到（宿主层调度）的回归测试。
 *
 * 断言的是**调度判据的边界**，不是领取协议（协议全在上游，这里只调 RPC）：
 * 1. 北京时区换算与时段判据（19:05 之前不领、错 tick 自愈到最近已到点时段）；
 * 2. 每个时段按北京日只跑一次，跨天重置水位线；
 * 3. 面板开关 / env 强制关闭两条腿各自生效，env 关闭时拒绝面板操作；
 * 4. RPC 失败如实记录且不阻断后续时段；坏状态文件不 crash；
 * 5. 控制器 HTTP 契约（GET /state、POST /enabled、400 / 409）。
 */
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import express from "express"
import { afterEach, test, vi } from "vite-plus/test"

import {
  ZCODE_CHECKIN_SLOTS,
  beijingParts,
  createZcodeCheckin,
  dueSlot,
  summarizeClaim,
} from "../src/modules/zcode-checkin/zcode-checkin.service.ts"
import { createZcodeCheckinController } from "../src/modules/zcode-checkin/zcode-checkin.controller.ts"
import { resolveZcodeAutoCheckin } from "../src/config/env.ts"

/** 2026-11-20T11:05:00Z = 北京 19:05（投放窗口第一个时段）。 */
const T1905 = Date.parse("2026-11-20T11:05:00Z")
const MIN = 60_000

function makeService(options: any = {}) {
  const home = mkdtempSync(join(tmpdir(), "c2a-zcode-checkin-"))
  const calls: Array<{ method: string; payload: any }> = []
  let clock = options.clock ?? T1905
  const service = createZcodeCheckin({
    home,
    rpc: async (method, payload) => {
      calls.push({ method, payload })
      if (options.rpcError) throw new Error(options.rpcError)
      return options.value ?? { results: [], summary: {} }
    },
    envEnabled: options.envEnabled,
    now: () => clock,
  })
  return { home, calls, service, setClock: (t: number) => (clock = t) }
}

afterEach(() => {
  vi.useRealTimers()
})

test("beijingParts：固定 UTC+8 换算，跨日边界正确", () => {
  assert.deepEqual(beijingParts(T1905), { date: "2026-11-20", minutes: 19 * 60 + 5 })
  // 北京 23:59 仍是当天
  assert.deepEqual(beijingParts(Date.parse("2026-11-20T15:59:00Z")), { date: "2026-11-20", minutes: 23 * 60 + 59 })
  // UTC 16:00 = 北京次日 00:00
  assert.deepEqual(beijingParts(Date.parse("2026-11-20T16:00:00Z")), { date: "2026-11-21", minutes: 0 })
})

test("dueSlot：19:05 之前无时段；之间取最近已到点；22:05 之后封顶", () => {
  assert.equal(dueSlot(19 * 60 + 4), undefined)
  assert.equal(dueSlot(19 * 60 + 5), "19:05")
  assert.equal(dueSlot(20 * 60 + 4), "19:05")
  assert.equal(dueSlot(20 * 60 + 5), "20:05")
  assert.equal(dueSlot(22 * 60 + 5), "22:05")
  assert.equal(dueSlot(23 * 60 + 59), "22:05")
  assert.equal(dueSlot(0), undefined)
})

test("summarizeClaim：空池 / 混合结果 / 全失败三种口径", () => {
  assert.deepEqual(summarizeClaim({ results: [] }), { ok: true, text: "没有 ZCode 账号", accounts: [] })
  const mixed = summarizeClaim({
    results: [
      { accountId: "a", nickname: "号A", outcome: { kind: "claimed", message: "+3M" } },
      { accountId: "b", nickname: "号B", outcome: { kind: "already-claimed", message: "今日暂无可领额度" } },
      { accountId: "c", nickname: "号C", outcome: { kind: "failed", message: "找不到浏览器" } },
    ],
  })
  assert.equal(mixed.ok, true)
  assert.match(mixed.text, /3 个账号/)
  assert.match(mixed.text, /领取 1/)
  assert.match(mixed.text, /已领\/暂无 1/)
  assert.match(mixed.text, /失败 1/)
  assert.match(mixed.text, /找不到浏览器/)
  assert.equal(mixed.accounts.length, 3)
  const allFailed = summarizeClaim({ results: [{ outcome: { kind: "failed", message: "x" } }] })
  assert.equal(allFailed.ok, false)
})

test("窗口前不领：tick 静默返回，不发 RPC、不落文件", async () => {
  const { calls, service, setClock } = makeService({ clock: Date.parse("2026-11-20T03:00:00Z") })
  assert.equal(await service.tick(), false)
  assert.equal(calls.length, 0)
  const state = await service.state()
  assert.equal(state.ranToday, false)
  assert.equal(state.enabled, true)
  setClock(T1905)
  assert.equal(await service.tick(), true)
  assert.equal(calls.length, 1)
})

test("每时段只跑一次：同水位线不重复打上游，推进到下一时段再跑", async () => {
  const { calls, service, setClock } = makeService()
  assert.equal(await service.tick(), true)
  assert.deepEqual(calls[0], { method: "credits.claimAll", payload: { provider: "zcode" } })
  assert.equal(await service.tick(), false)
  assert.equal(calls.length, 1)
  // 错 tick（19:30 才巡检到）仍落在 19:05 水位线，不重复
  setClock(T1905 + 25 * MIN)
  assert.equal(await service.tick(), false)
  // 20:05 到点 → 第二轮
  setClock(T1905 + 60 * MIN)
  assert.equal(await service.tick(), true)
  assert.equal(calls.length, 2)
  const state = await service.state()
  assert.deepEqual(state.ranSlots, ["19:05", "20:05"])
  assert.equal(state.ranToday, true)
  assert.equal(state.lastSlot, "20:05")
})

test("跨天重置水位线：次日 19:05 重新开跑", async () => {
  const { calls, service, setClock } = makeService()
  await service.tick()
  setClock(T1905 + 24 * 60 * MIN)
  const state = await service.state()
  assert.deepEqual(state.ranSlots, [])
  assert.equal(state.ranToday, false)
  assert.equal(await service.tick(), true)
  assert.equal(calls.length, 2)
  const after = await service.state()
  assert.deepEqual(after.ranSlots, ["19:05"])
  assert.equal(after.today, "2026-11-21")
})

test("面板开关：关闭后到点不领，状态持久化，重新打开恢复", async () => {
  const { home, calls, service } = makeService()
  await service.setEnabled(false)
  assert.equal(await service.tick(), false)
  assert.equal(calls.length, 0)
  assert.equal((await service.state()).enabled, false)
  // 重建实例（模拟重启）仍读到关闭
  const restarted = createZcodeCheckin({ home, rpc: async () => ({ results: [] }), now: () => T1905 })
  assert.equal((await restarted.state()).enabled, false)
  assert.equal(await restarted.tick(), false)
  await service.setEnabled(true)
  assert.equal(await service.tick(), true)
  assert.equal(calls.length, 1)
})

test("env 强制关闭：面板置灰、拒绝操作、到点不领", async () => {
  const { calls, service } = makeService({ envEnabled: false })
  const state = await service.state()
  assert.equal(state.envLocked, true)
  assert.equal(state.enabled, false)
  await assert.rejects(() => service.setEnabled(true), /CODEARTS2API_ZCODE_AUTO_CHECKIN/)
  assert.equal(await service.tick(), false)
  assert.equal(calls.length, 0)
})

test("RPC 失败如实记录：本时段记失败，下一时段天然重试", async () => {
  const { calls, service, setClock } = makeService({ rpcError: "jet-hub 路由未注册" })
  assert.equal(await service.tick(), true)
  const state = await service.state()
  assert.equal(state.lastResult.ok, false)
  assert.match(state.lastResult.text, /jet-hub 路由未注册/)
  assert.deepEqual(state.ranSlots, ["19:05"])
  assert.equal(await service.tick(), false)
  setClock(T1905 + 60 * MIN)
  assert.equal(await service.tick(), true)
  assert.equal(calls.length, 2)
})

test("坏状态文件不 crash：按缺省读出，调度照常", async () => {
  const { home, calls, service } = makeService()
  writeFileSync(join(home, "zcode-auto-checkin.json"), "{bad json")
  const state = await service.state()
  assert.equal(state.enabled, true)
  assert.deepEqual(state.ranSlots, [])
  assert.equal(await service.tick(), true)
  assert.equal(calls.length, 1)
})

test("start/stop：启动延迟补跑一次，stop 后定时器不再触发", async () => {
  // 只 fake 调度用的四种定时器：tick 里的文件读写是真实 I/O，setImmediate 必须留真，
  // 否则推进假时间后断言会跑在 I/O 完成之前（时序偶发红的根因）。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
  const flush = async (rounds = 20) => {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((resolve) => setImmediate(resolve))
  }
  const { calls, service } = makeService()
  service.start()
  await vi.advanceTimersByTimeAsync(30_000)
  await until(() => calls.length === 1)
  assert.equal(calls.length, 1)
  await vi.advanceTimersByTimeAsync(60_000)
  // 19:05 水位线已记，巡检不重复打
  await flush()
  assert.equal(calls.length, 1)
  service.stop()
  await vi.advanceTimersByTimeAsync(120_000)
  await flush()
  assert.equal(calls.length, 1)
})

test("resolveZcodeAutoCheckin：默认放行，0/false/off/no 强制关闭", () => {
  assert.equal(resolveZcodeAutoCheckin({}), true)
  assert.equal(resolveZcodeAutoCheckin({ CODEARTS2API_ZCODE_AUTO_CHECKIN: "" }), true)
  for (const raw of ["0", "false", "off", "no", "OFF"]) {
    assert.equal(resolveZcodeAutoCheckin({ CODEARTS2API_ZCODE_AUTO_CHECKIN: raw }), false)
  }
  assert.equal(resolveZcodeAutoCheckin({ CODEARTS2API_ZCODE_AUTO_CHECKIN: "1" }), true)
})

test("控制器 HTTP：GET /state、POST /enabled、非法 body 400、env 锁定 409", async () => {
  const { service } = makeService()
  const app = express()
  app.use("/api", createZcodeCheckinController({ service }).router)
  const server = app.listen(0)
  await new Promise((resolve) => server.once("listening", resolve))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const state = await (await fetch(origin + "/api/state")).json()
    assert.equal(state.enabled, true)
    assert.deepEqual(state.slots, [...ZCODE_CHECKIN_SLOTS])

    const off = await fetch(origin + "/api/enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(off.status, 200)
    assert.equal((await off.json()).enabled, false)

    const bad = await fetch(origin + "/api/enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    })
    assert.equal(bad.status, 400)
  } finally {
    server.close()
  }

  const locked = makeService({ envEnabled: false })
  const app2 = express()
  app2.use("/api", createZcodeCheckinController({ service: locked.service }).router)
  const server2 = app2.listen(0)
  await new Promise((resolve) => server2.once("listening", resolve))
  const origin2 = `http://127.0.0.1:${(server2.address() as any).port}`
  try {
    const res = await fetch(origin2 + "/api/enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /CODEARTS2API_ZCODE_AUTO_CHECKIN/)
  } finally {
    server2.close()
  }
})

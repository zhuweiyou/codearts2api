import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import { isReplayableUrl, loopbackFromRelay, relayLoopbackUrl } from "../web/utils/oauth-relay.ts"

const ORIGIN = "https://admin.example.com"

test("loopback → /relay 改写（含路径与查询）", () => {
  assert.equal(
    relayLoopbackUrl("http://127.0.0.1:19283/auth/cb?code=x", ORIGIN),
    `${ORIGIN}/relay/19283/auth/cb?code=x`,
  )
  assert.equal(relayLoopbackUrl("http://localhost:20001/cb", ORIGIN), `${ORIGIN}/relay/20001/cb`)
  assert.equal(relayLoopbackUrl("http://127.0.0.1:19283", ORIGIN), `${ORIGIN}/relay/19283/`)
})

test("非 loopback 原样返回", () => {
  assert.equal(relayLoopbackUrl("https://api.other.com/x", ORIGIN), "https://api.other.com/x")
  assert.equal(relayLoopbackUrl("", ORIGIN), "")
})

test("relay → loopback 还原（供重放）", () => {
  assert.equal(
    loopbackFromRelay(`${ORIGIN}/relay/19283/auth/cb?code=x`, ORIGIN),
    "http://127.0.0.1:19283/auth/cb?code=x",
  )
  assert.equal(loopbackFromRelay("https://nope.com/relay/1/x", ORIGIN), "https://nope.com/relay/1/x")
})

test("isReplayableUrl 判定 loopback 与 relay", () => {
  assert.equal(isReplayableUrl("http://127.0.0.1:19283/cb", ORIGIN), true)
  assert.equal(isReplayableUrl(`${ORIGIN}/relay/19283/cb`, ORIGIN), true)
  assert.equal(isReplayableUrl("https://other.com/cb", ORIGIN), false)
  assert.equal(isReplayableUrl("", ORIGIN), false)
})

import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import { startTestApp } from "./helpers"

test("旧版 models POST action 协议仍可用（迁移兼容）", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  const headers = { authorization: `Bearer ${app.adminKey}`, "content-type": "application/json" }
  const listed = await fetch(`${app.origin}/admin/models/api`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "list", provider: "opencode" }),
  })
  assert.equal(listed.status, 200)
  const listBody = await listed.json()
  assert.equal(listBody.provider, "opencode")
  assert.ok(Array.isArray(listBody.models))

  const status = await fetch(`${app.origin}/admin/models/api`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "status", providers: ["opencode"] }),
  })
  assert.equal(status.status, 200)
  assert.ok((await status.json()).statuses)
})

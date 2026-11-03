/**
 * /admin/callers/api 的入参契约测试。
 *
 * 为什么必须有这组测试：调用方弹窗（src/callers-ui.js）与后端（src/caller-admin.js）
 * 之间没有共享的类型定义，前端发什么就是什么。曾经出现过一次真实事故——前端把
 * 参数各自包了一层（{action:"group.save", group:{...}}），而后端只读顶层字段，
 * 于是「新建分组」「新建 key」直接 400 报空名，而「编辑 key」因为三处 typeof 守卫
 * 全部跳过，变成**静默不生效**：界面显示保存成功，刷新后什么都没变。这类错误不会
 * 抛异常、不会写日志，只能靠契约测试钉住。
 *
 * 所以这里断言的不是「功能好不好用」，而是**请求形状与后端读法必须对齐**：
 * 顶层扁平字段才是契约，嵌套形态必须被拒绝（而不是被悄悄忽略）。
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { startTestApp } from "./helpers.mjs"

/**
 * 发一次 /admin/callers/api 请求。
 *
 * 一律带管理员 key：这个接口挂在鉴权门之后，匿名会被重定向到登录页，
 * 那样测到的就不是入参契约了。
 */
async function callApi(app, payload) {
  const response = await fetch(`${app.origin}/admin/callers/api`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${app.adminKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

/** 取一次页面状态，用来验证写操作是否真的落盘（而不是只看 200）。 */
async function readState(app) {
  const { status, body } = await callApi(app, { action: "state" })
  assert.equal(status, 200)
  return body
}

test("group.save 接受顶层扁平字段", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const saved = await callApi(app, {
    action: "group.save",
    name: "team-a",
    desc: "甲组",
    allow: ["vendor/model-1", "vendor/model-2", "vendor/model-1"],
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body, { ok: true })

  const state = await readState(app)
  assert.equal(state.groups.length, 1)
  assert.equal(state.groups[0].name, "team-a")
  assert.equal(state.groups[0].desc, "甲组")
  // allow 去重保序：重复项只留一份。
  assert.deepEqual(state.groups[0].allow, ["vendor/model-1", "vendor/model-2"])
})

test("group.save 拒绝旧的嵌套 payload（不再静默忽略）", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 这是修复前的真实形态。后端只读顶层 name，嵌套里写了也不认 ⇒ 必须报错，
  // 而不是「200 但什么都没存」。
  const nested = await callApi(app, {
    action: "group.save",
    group: { name: "team-b", desc: "乙组", allow: ["*"] },
  })
  assert.equal(nested.status, 400)
  assert.match(nested.body.error, /分组名不能为空/)

  const state = await readState(app)
  assert.deepEqual(state.groups, [])
})

test("key.add 接受顶层扁平字段并透传 enabled=false", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  await callApi(app, { action: "group.save", name: "team-a", allow: ["*"] })

  const added = await callApi(app, {
    action: "key.add",
    name: "调用方-1",
    group: "team-a",
    enabled: false,
  })
  assert.equal(added.status, 200)
  assert.match(added.body.key, /^k_[0-9a-f]{6}$/)
  assert.equal(added.body.group, "team-a")
  assert.match(added.body.secret, /^p_/)

  const state = await readState(app)
  assert.equal(state.keys.length, 1)
  assert.equal(state.keys[0].name, "调用方-1")
  // N4：enabled 不再写死 true，前端关掉就是关掉。
  assert.equal(state.keys[0].enabled, false)
  // 明文 secret 只在响应里出现一次，state 只回 sha 前缀。
  assert.equal(state.keys[0].sha.length, 8)
  assert.equal("secret" in state.keys[0], false)
})

test("key.add 缺省 enabled 时默认为启用", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  await callApi(app, { action: "group.save", name: "team-a", allow: ["*"] })
  const added = await callApi(app, { action: "key.add", name: "调用方-1", group: "team-a" })
  assert.equal(added.status, 200)

  const state = await readState(app)
  assert.equal(state.keys[0].enabled, true)
})

test("key.add 拒绝旧的嵌套 payload", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  await callApi(app, { action: "group.save", name: "team-a", allow: ["*"] })
  const nested = await callApi(app, {
    action: "key.add",
    key: { name: "调用方-1", group: "team-a", enabled: true },
  })
  assert.equal(nested.status, 400)
  assert.match(nested.body.error, /名字不能为空/)

  const state = await readState(app)
  assert.deepEqual(state.keys, [])
})

test("key.update 用顶层字段改名换组（旧写法会静默不生效）", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  await callApi(app, { action: "group.save", name: "team-a", allow: ["*"] })
  await callApi(app, { action: "group.save", name: "team-b", allow: ["*"] })
  const added = await callApi(app, { action: "key.add", name: "调用方-1", group: "team-a" })
  const id = added.body.key

  const updated = await callApi(app, {
    action: "key.update",
    id,
    name: "调用方-renamed",
    group: "team-b",
    enabled: false,
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.ok, true)
  assert.equal(updated.body.key.name, "调用方-renamed")
  assert.equal(updated.body.key.group, "team-b")
  assert.equal(updated.body.key.enabled, false)

  const state = await readState(app)
  assert.equal(state.keys[0].name, "调用方-renamed")
  assert.equal(state.keys[0].group, "team-b")
  assert.equal(state.keys[0].enabled, false)
})

test("key.update 的嵌套 patch 形态不会改动任何字段", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  await callApi(app, { action: "group.save", name: "team-a", allow: ["*"] })
  const added = await callApi(app, { action: "key.add", name: "调用方-1", group: "team-a" })
  const id = added.body.key

  // 修复前前端就是这么发的：顶层只有 id，改名换组全在 patch 里。
  // 后端读不到任何可改字段 ⇒ 返回 200 但条目分毫未变，这就是那条「静默」缺陷。
  const nested = await callApi(app, {
    action: "key.update",
    id,
    patch: { name: "调用方-renamed", enabled: false },
  })
  assert.equal(nested.status, 200)
  assert.equal(nested.body.key.name, "调用方-1")
  assert.equal(nested.body.key.enabled, true)

  const state = await readState(app)
  assert.equal(state.keys[0].name, "调用方-1")
  assert.equal(state.keys[0].enabled, true)
})

test("key.update 换到不存在的分组会报错且不落盘", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  await callApi(app, { action: "group.save", name: "team-a", allow: ["*"] })
  const added = await callApi(app, { action: "key.add", name: "调用方-1", group: "team-a" })
  const id = added.body.key

  const moved = await callApi(app, { action: "key.update", id, group: "no-such-group" })
  assert.equal(moved.status, 400)
  assert.match(moved.body.error, /分组 no-such-group 不存在/)

  const state = await readState(app)
  assert.equal(state.keys[0].group, "team-a")
})

test("group.rm 在分组仍被 key 使用时拒绝删除", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  await callApi(app, { action: "group.save", name: "team-a", allow: ["*"] })
  await callApi(app, { action: "key.add", name: "调用方-1", group: "team-a" })

  const removed = await callApi(app, { action: "group.rm", name: "team-a" })
  assert.equal(removed.status, 400)
  assert.match(removed.body.error, /仍被 1 把 key 使用（调用方-1）/)

  const state = await readState(app)
  assert.equal(state.groups.length, 1)
})

test("key.rm 之后 group.rm 可以正常删组", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  await callApi(app, { action: "group.save", name: "team-a", allow: ["*"] })
  const added = await callApi(app, { action: "key.add", name: "调用方-1", group: "team-a" })
  const id = added.body.key

  const keyGone = await callApi(app, { action: "key.rm", id })
  assert.equal(keyGone.status, 200)
  assert.deepEqual(keyGone.body, { ok: true })

  const groupGone = await callApi(app, { action: "group.rm", name: "team-a" })
  assert.equal(groupGone.status, 200)
  assert.deepEqual(groupGone.body, { ok: true })

  const state = await readState(app)
  assert.deepEqual(state.groups, [])
  assert.deepEqual(state.keys, [])
})

test("state 附带模型清单且不阻塞", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  // 模型清单来自本进程的网关（startTestApp 会给随机端口起一个）。
  // 这里只钉两件事：形状是字符串数组（前端拿它渲染白名单勾选项），
  // 以及拿不到时的超时兜底不会把弹窗拖住（上限 8 秒，实测远低于此）。
  const started = Date.now()
  const state = await readState(app)
  assert.ok(Array.isArray(state.models))
  assert.ok(state.models.every((id) => typeof id === "string" && id.length > 0))
  assert.ok(Date.now() - started < 2000, "state 不应因为拉模型清单而阻塞")
  assert.equal(typeof state.storePath, "string")
  assert.match(state.usage.day, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(state.usage.rows, [])
})

test("只接受 POST", async (t) => {
  const app = await startTestApp()
  t.after(() => app.close())

  const response = await fetch(`${app.origin}/admin/callers/api`, {
    method: "GET",
    headers: { authorization: `Bearer ${app.adminKey}` },
  })
  assert.equal(response.status, 405)
  assert.deepEqual(await response.json(), { error: "只支持 POST" })
})

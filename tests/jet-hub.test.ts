/**
 * 用户的两个核心诉求：**多渠道增删改查** + **网关开关**。
 *
 * ## 为什么用 backup.import 来造账号，而不是走 account.create
 *
 * `account.create` 会真的发起上游登录（起本地回调服务器、等浏览器授权），
 * 在 CI 里不可行。而 `backup.import` 是**纯本地**的写入路径（凭据 + 账号索引
 * 整体替换），既能造出真实的账号状态，又顺带覆盖了「备份往返」这条实用功能
 * ——远程部署时用户导入已有账号走的正是它。
 *
 * ## 网关断言为什么看 `running` 而不只看 `enabled`
 *
 * `enabled` 是**期望状态**（落盘的开关），`running` 才是**是否真的在监听**。
 * 端口被占用、或被 `DSH_OPENAI_GATEWAY_ENABLED` 停用时，两者会不一致 ——
 * 而这正是用户最容易误判的场景，所以必须断言 `running`。
 */

import { test } from "vite-plus/test"
import assert from "node:assert/strict"
import { startTestApp, rpc } from "./helpers"

/** 构造一份含一个 codearts 账号的最小备份载荷。 */
function backupPayload(accountId, credentialRef) {
  return {
    format: "dsh-codearts-auth/backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    credentials: {
      [credentialRef]: JSON.stringify({
        access_key_id: "AKIDEXAMPLE",
        secret_access_key: "SECRETEXAMPLE",
        security_token: "TOKENEXAMPLE",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    },
    accounts: [
      {
        id: accountId,
        provider: "codearts",
        nickname: "测试账号",
        enabled: true,
        credentialRef,
        refreshable: true,
        createdAt: Date.now(),
      },
    ],
    disabledModels: {},
    permanentLocks: {},
  }
}

test("多渠道账号：导入 → 列表 → 停用 → 删除", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  // ① 导入一个账号（凭据 + 索引一起写入）。
  const imported = await rpc(app.origin, "backup.import", {
    payload: backupPayload("codearts-TEST0001", "CODEARTS_ACCOUNT_TEST0001"),
  })
  assert.equal(imported.ok, true, `导入应成功：${JSON.stringify(imported)}`)
  assert.equal(imported.value.accountsImported, 1)
  assert.equal(imported.value.credentialsImported, 1)
  assert.equal(imported.value.missingCredentials, 0, "凭据必须一并写入，否则账号是空壳")

  // ② 列表能读到它，且凭据可解析（source 有值 = credentials.describe 命中）。
  const listed = await rpc(app.origin, "account.list", { provider: "codearts" })
  assert.equal(listed.ok, true)
  assert.equal(listed.value.accounts.length, 1)
  const [account] = listed.value.accounts
  assert.equal(account.id, "codearts-TEST0001")
  assert.equal(account.enabled, true)
  assert.ok(account.source, "账号应带上凭据来源（说明凭据确实写进了 seam）")

  // ③ 停用（改）。
  const updated = await rpc(app.origin, "account.update", {
    accountId: "codearts-TEST0001",
    patch: { enabled: false },
  })
  assert.equal(updated.ok, true, `停用应成功：${JSON.stringify(updated)}`)
  const afterUpdate = await rpc(app.origin, "account.list", { provider: "codearts" })
  assert.equal(afterUpdate.value.accounts[0].enabled, false, "停用应落盘")

  // ④ 删除，连同凭据一起清掉。
  const removed = await rpc(app.origin, "account.delete", { accountId: "codearts-TEST0001" })
  assert.equal(removed.ok, true, `删除应成功：${JSON.stringify(removed)}`)
  const afterDelete = await rpc(app.origin, "account.list", { provider: "codearts" })
  assert.equal(afterDelete.value.accounts.length, 0)

  // 再导入一次不应看到旧凭据残留（删除时真的 unset 了）。
  const reimported = await rpc(app.origin, "backup.import", {
    payload: backupPayload("codearts-TEST0002", "CODEARTS_ACCOUNT_TEST0002"),
  })
  assert.equal(reimported.value.accountsImported, 1)
  const final = await rpc(app.origin, "account.list", { provider: "codearts" })
  assert.deepEqual(
    final.value.accounts.map((entry) => entry.id),
    ["codearts-TEST0002"],
  )
})

test("备份导出 → 导入往返保持一致", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  await rpc(app.origin, "backup.import", {
    payload: backupPayload("codearts-ROUND01", "CODEARTS_ACCOUNT_ROUND01"),
  })

  const exported = await rpc(app.origin, "backup.export", {})
  assert.equal(exported.ok, true)
  assert.ok(exported.value.payload, "导出应带 payload")

  // 导入回同一实例：整体替换语义，结果应完全一致。
  const restored = await rpc(app.origin, "backup.import", { payload: exported.value.payload })
  assert.equal(restored.ok, true, `回导应成功：${JSON.stringify(restored)}`)
  assert.equal(restored.value.accountsImported, 1)
  assert.equal(restored.value.missingCredentials, 0)

  const listed = await rpc(app.origin, "account.list", { provider: "codearts" })
  assert.equal(listed.value.accounts.length, 1)
  assert.equal(listed.value.accounts[0].id, "codearts-ROUND01")
})

test("网关：默认开启并真的在监听", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  const status = await rpc(app.origin, "gateway.getEnabled", {})
  assert.equal(status.ok, true)
  assert.equal(status.value.enabled, true, "缺省应为启用")
  assert.equal(status.value.running, true, "应真的在监听端口")
  assert.ok(status.value.address?.port, "应回传监听地址")
  assert.ok(status.value.apiKey?.value, "应回传 API Key（供用户配置客户端）")

  // 网关真的能应答 OpenAI 协议：无 Key 401、带 Key 200。
  const base = `http://${status.value.address.host}:${status.value.address.port}`
  const unauthorized = await fetch(`${base}/v1/models`)
  assert.equal(unauthorized.status, 401, "无 Bearer Key 应 401")

  const authorized = await fetch(`${base}/v1/models`, {
    headers: { authorization: `Bearer ${status.value.apiKey.value}` },
  })
  assert.equal(authorized.status, 200, "带正确 Key 应 200")
  const body = await authorized.json()
  assert.equal(body.object, "list")
})

test("网关：可即时关闭与重新打开（无需重启）", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  const initial = await rpc(app.origin, "gateway.getEnabled", {})
  const { host, port } = initial.value.address

  // ── 关闭 ──
  const off = await rpc(app.origin, "gateway.setEnabled", { enabled: false })
  assert.equal(off.ok, true, `关闭应成功：${JSON.stringify(off)}`)
  assert.equal(off.value.enabled, false)
  assert.equal(off.value.running, false, "关闭后不应仍在监听")

  // 端口真的没了：连接应失败（用 abort 超时兜住，避免测试挂住）。
  await assert.rejects(
    fetch(`http://${host}:${port}/v1/models`, {
      signal: AbortSignal.timeout(1500),
      headers: { authorization: `Bearer ${initial.value.apiKey.value}` },
    }),
    "关闭后端口应不可连接",
  )

  // 关闭后仍要能读到 Key —— 用户恰恰可能在关着的时候去复制它配客户端。
  const offStatus = await rpc(app.origin, "gateway.getEnabled", {})
  assert.equal(offStatus.value.running, false)
  assert.ok(offStatus.value.apiKey?.value, "网关关闭后仍应能读到 API Key")

  // ── 重新打开 ──
  const on = await rpc(app.origin, "gateway.setEnabled", { enabled: true })
  assert.equal(on.ok, true, `打开应成功：${JSON.stringify(on)}`)
  assert.equal(on.value.running, true, "重新打开后应恢复监听")

  const back = await fetch(`http://${host}:${on.value.address.port}/v1/models`, {
    headers: { authorization: `Bearer ${on.value.apiKey.value}` },
  })
  assert.equal(back.status, 200, "重新打开后应可访问")
})

test("模型开关：可关闭与打开单个模型", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  // ⚠️ 用 aggregate 而不是 codearts：上游 43a00cd（2026-11-23）起，codearts 的
  //    模型目录**完全走远端**，静态兜底表退出目录路径（方案 B）。测试环境没有
  //    真实账号与远节目录，`model.list` 会返回空数组，取不到可开关的 id。
  //    aggregate 的 `auto` 是**恒合成**的模型（不依赖任何渠道目录；冷启动时
  //    `listModels` 只播报它，目录推导在后台进行），适合验证「单模型开关」
  //    这条机制本身。
  const before = await rpc(app.origin, "model.list", { provider: "aggregate" })
  assert.equal(before.ok, true)
  assert.ok(before.value.models.length > 0, "aggregate 冷缓存应有合成模型（auto）")

  const target = before.value.models[0].id
  const disabled = await rpc(app.origin, "model.setDisabled", {
    provider: "aggregate",
    modelId: target,
    disabled: true,
  })
  assert.equal(disabled.ok, true, `关闭模型应成功：${JSON.stringify(disabled)}`)

  const afterDisable = await rpc(app.origin, "model.list", { provider: "aggregate" })
  const found = afterDisable.value.models.find((model) => model.id === target)
  assert.equal(found?.disabled, true, "该模型应显示为已关闭")

  // 打开（黑名单是显式 true 才关，故恢复要显式写 false）。
  const enabled = await rpc(app.origin, "model.setDisabled", {
    provider: "aggregate",
    modelId: target,
    disabled: false,
  })
  assert.equal(enabled.ok, true)
  const afterEnable = await rpc(app.origin, "model.list", { provider: "aggregate" })
  const reopened = afterEnable.value.models.find((model) => model.id === target)
  assert.equal(reopened?.disabled, false, "应恢复为打开")
})

test("供应商级开关：一键关闭与打开", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  // ⚠️ 用 doubao 而不是 codearts：doubao 是「纯签到渠道」（无模型目录 / 适配器 /
  //    auth 服务），`provider.status` 对它恒报 `models.total === 0` —— 这正是
  //    本用例要覆盖的「目录为空」形态（上游 2026-11-15 修过「豆包无法关闭」）。
  //    codearts 自 43a00cd 起目录完全走远端，测试环境没有账号，行为依赖网络，
  //    不再适合作为这条断言的载体。
  const status = await rpc(app.origin, "provider.status", { providers: ["doubao"] })
  assert.equal(status.ok, true)
  assert.equal(status.value.statuses.doubao.models.total, 0, "纯签到渠道应恒为空目录")

  // ⚠️ 两个写黑名单的端点**刻意用不同判据**（上游 2026-10-13 明确分工，别「顺手统一」）：
  //
  // | 端点 | 判据 | 目录不完整时 |
  // | --- | --- | --- |
  // | `model.setAllDisabled`（模型级批量） | `catalog.complete` | **拒绝**、不落盘 |
  // | `provider.setEnabled`（供应商级） | `catalog.remoteError` | 读**失败**才拒绝；读到但为空**照常关闭** |
  //
  // ☝️ 那张表是**有模型适配器**的供应商会走的分支。本用例选的 doubao 更靠前：
  //    它 `channel: false` 且 `modelAdapters` 里没有它 ⇒ 上游在 `provider.setEnabled`
  //    开头就判 `noModelLeg`，**根本不读模型目录**（硬去读只会抛
  //    `no adapter registered for provider "doubao"`），只落「关闭意图」。
  //    这正是上游 2026-11-15 修的那条「豆包无法关闭」：目录为空是**真实且正常**的
  //    形态，不是故障，所以不能按「没有可关闭的模型」拒绝。
  //
  // ⚠️ 「空目录照常关闭」与「非模型渠道跳过模型腿」是**两条不同的腿**：
  //    前者仍会读远端（读到 `[]` 才放行），后者连读都不读 —— 对 doubao 而言
  //    模型这条腿根本不存在，不属于「读失败」。本用例锁定的是后者。

  const closed = await rpc(app.origin, "provider.setEnabled", { provider: "doubao", enabled: false })
  assert.equal(closed.ok, true, `空目录供应商应能关闭：${JSON.stringify(closed)}`)
  // 空目录 ⇒ 没有模型 id 要写黑名单（models=0 是正确结果），但「关闭意图」仍要落盘；
  // 下面的 closed=true 断言验证的正是意图这条腿。
  assert.equal(closed.value.models, 0, "空目录关闭时无模型可写，models 应为 0")

  // 关闭后状态自洽：显示已关闭（意图判据），而不是依赖「黑名单覆盖全部目录」。
  const afterClose = await rpc(app.origin, "provider.status", { providers: ["doubao"] })
  assert.equal(afterClose.value.statuses.doubao.closed, true, "应显示为整体关闭")

  // 打开方向只清黑名单，应始终成功 —— 且把状态恢复为打开。
  const opened = await rpc(app.origin, "provider.setEnabled", { provider: "doubao", enabled: true })
  assert.equal(opened.ok, true, `打开供应商应成功：${JSON.stringify(opened)}`)
  const afterOpen = await rpc(app.origin, "provider.status", { providers: ["doubao"] })
  assert.equal(afterOpen.value.statuses.doubao.closed, false, "应恢复为打开")
})

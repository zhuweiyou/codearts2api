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

/**
 * 供应商级开关的载体：从**实际注册**的渠道里挑「目录非空、当前未关闭」的，
 * 而不是写死某个渠道的名字。
 *
 * 为什么不写死：上游会调整渠道形态 —— 2026-11-22 的 `0ea3e43e` 就把 doubao
 * 从「纯签到渠道」接成了有静态目录的渠道，写死属性会让自动升级流水线每天红
 * 一次。这里改为按当前状态挑，只有「所有渠道都关不掉」才是真故障。
 *
 * 排除虚拟渠道（aggregate / auto）：它们的目录是动态推导的，关闭方向有
 * 「目录尚未读取完成就拒绝」的分支，不适合作为这条用例的载体。
 *
 * 最多返回 3 个候选：每个被拒的关闭最多付一次目录读取（2s 预算），候选太多
 * 会把用例拖过 30s 超时。
 */
async function pickToggleCandidates(app) {
  const llm = app.host.ctx.get("llm")
  const ids = llm
    .listProviders()
    .map((entry) => entry.id)
    .filter((id) => id !== "aggregate" && id !== "auto" && id !== "jet-hub-auto")
  const status = await rpc(app.origin, "provider.status", { providers: ids })
  assert.equal(status.ok, true, `provider.status 应成功：${JSON.stringify(status)}`)
  const candidates = ids
    .filter((id) => {
      const item = status.value.statuses[id]
      return item !== undefined && item.models.total > 0 && item.closed === false
    })
    .slice(0, 3)
  assert.ok(
    candidates.length > 0,
    `应至少有一个「目录非空且未关闭」的渠道，实际注册：${ids.join(", ") || "(空)"}`,
  )
  return candidates
}

test("供应商级开关：一键关闭与打开", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  // ⚠️ 不写死渠道：从实际注册的渠道里挑一个「目录非空、未关闭」的。
  //    上游调整某个渠道的形态（例如把纯签到渠道接成有目录的渠道）时，这条用例
  //    自动换载体，不再因为某个渠道的属性变了就让自动升级流水线每天红一次。
  //
  // ⚠️ 两个写黑名单的端点**刻意用不同判据**（上游 2026-10-13 明确分工，别「顺手统一」）：
  //
  // | 端点 | 判据 | 目录不完整时 |
  // | --- | --- | --- |
  // | `model.setAllDisabled`（模型级批量） | `catalog.complete` | **拒绝**、不落盘 |
  // | `provider.setEnabled`（供应商级） | `catalog.remoteError` | 读**失败**才拒绝；读到但为空**照常关闭** |
  //
  // 关闭被拒的候选（目录读失败 / 目录未就绪）换下一个：这两条拒绝分支
  // 一个字节都不落盘，换候选是安全的。
  const candidates = await pickToggleCandidates(app)
  let picked
  let closed
  const failures = []
  for (const id of candidates) {
    const attempt = await rpc(app.origin, "provider.setEnabled", { provider: id, enabled: false })
    if (attempt.ok) {
      picked = id
      closed = attempt
      break
    }
    failures.push(`${id}: ${attempt.error?.message ?? JSON.stringify(attempt)}`)
  }
  assert.ok(picked, `候选渠道都无法关闭：${failures.join(" | ")}`)

  // 关闭 = 停用账号 + 把目录里的全部模型写进黑名单 + 落关闭意图。
  assert.ok(closed.value.models > 0, `关闭应写入模型黑名单：${JSON.stringify(closed)}`)

  // 关闭后状态自洽：目录里的模型全部进黑名单 + 显示整体关闭。
  const afterClose = await rpc(app.origin, "provider.status", { providers: [picked] })
  const closedStatus = afterClose.value.statuses[picked]
  assert.equal(closedStatus.models.disabled, closedStatus.models.total, "关闭后目录里的模型应全部进黑名单")
  assert.equal(closedStatus.closed, true, "应显示为整体关闭")

  // 打开方向只清黑名单，应始终成功 —— 且把状态恢复为打开。
  const opened = await rpc(app.origin, "provider.setEnabled", { provider: picked, enabled: true })
  assert.equal(opened.ok, true, `打开供应商应成功：${JSON.stringify(opened)}`)
  const afterOpen = await rpc(app.origin, "provider.status", { providers: [picked] })
  assert.equal(afterOpen.value.statuses[picked].closed, false, "应恢复为打开")
})

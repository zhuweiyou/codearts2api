/**
 * 状态隔离与凭据可读性 —— 对应两个**真实故障**的回归测试。
 *
 * ## 故障一：跑到 DSH 的目录里
 *
 * 第一版沿用了插件的 home 判据（`DSH_HOME` → `~/.dsh`）。在一台装过 DSH 的
 * 机器上，外层 shell 早被 DSH 导出了 `DSH_HOME=/Users/<user>/.dsh`，本程序
 * **继承**了它，把账号与凭据写进 DSH 的目录，两边互相覆盖。
 *
 * ## 故障二：凭据格式臆造 → 永远读不到
 *
 * 第一版自己写了个凭据服务，落在 `<home>/jet-hub/credentials.json` —— 但真实
 * DSH 的凭据文档是 `<home>/.credentials.yaml`。于是**账号列表读得到**
 * （`state.json` 格式一致），而**每条凭据都读不到**，界面一直提示
 * 「凭据未配置」。现已改为复用官方 `@deepseek-ai/dsh-credentials-local`。
 */

import { test } from "vite-plus/test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { startTestApp, rpc } from "./helpers"

test("用 CODEARTS2API_HOME 解析 home，且与 DSH 隔离", async (t) => {
  // 模拟「装过 DSH 的机器」：环境里已有一个 DSH 的 home 变量。
  const decoy = mkdtempSync(join(tmpdir(), "c2a-decoy-"))
  process.env.DSH_HOME = decoy
  process.env.DSH_JET_HUB_STATE_DIR = decoy

  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  // 我们的 home 必须是自己那份，不能是 DSH 的。
  // ⚠️ 只比 `decoy` 是不够的：`startTestApp` 已把 `JET_HUB_STATE_DIR` 覆盖成
  //    我们的 home，所以「拿它跟 app.home 比不等」会恒真失败（写测试时踩过）。
  //    要断言的是「它**已经不是**开始时那个 decoy 值」。
  assert.notEqual(app.home, decoy, "不应沿用外层 DSH_HOME")
  assert.notEqual(
    process.env.DSH_JET_HUB_STATE_DIR,
    decoy,
    "必须覆盖外层的 JET_HUB_STATE_DIR（否则账号池会写进 DSH 的目录）",
  )

  // 两个插件变量都被覆盖成我们的 home（插件内部就是这么找目录的）。
  assert.equal(process.env.DSH_HOME, app.home, "应把 DSH_HOME 覆盖为自己的 home")
  assert.equal(process.env.DSH_JET_HUB_STATE_DIR, app.home, "应把 JET_HUB_STATE_DIR 覆盖为自己的 home")

  // 凭据文档必须落在我们自己的 home 下。
  assert.equal(app.host.credentialsFile, join(app.home, ".credentials.yaml"))
  assert.ok(app.host.credentialsFile.startsWith(app.home), "凭据文档应在自家目录内")

  // 健康检查也应回显自己的 home（而不是 DSH 的）。
  const health = await (await fetch(`${app.origin}/healthz`)).json()
  assert.equal(health.home, app.home)
})

test("既有凭据可被读取（不会被报「凭据未配置」）", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "c2a-seed-"))
  process.env.CODEARTS2API_HOME = home
  // 预置一份**合法的**凭据文档（与 DSH 同一格式：version/refs）。
  // 用官方的解析器能读它，正是「不再臆造格式」的证明。
  writeFileSync(
    join(home, ".credentials.yaml"),
    [
      "version: 1",
      "refs:",
      `  BUDDY_ACCOUNT_SEED01: '{"access_token":"seeded-token","expires_at":"2030-01-01T00:00:00Z"}'`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  )
  // 账号索引指向那条凭据。
  mkdirSync(join(home, "jet-hub"), { recursive: true })
  writeFileSync(
    join(home, "jet-hub", "state.json"),
    JSON.stringify({
      accounts: [
        {
          id: "buddy-seed01",
          provider: "buddy",
          nickname: "预置账号",
          enabled: true,
          credentialRef: "BUDDY_ACCOUNT_SEED01",
          refreshable: true,
          createdAt: Date.now(),
        },
      ],
      disabledModels: {},
      gatewayEnabled: true,
    }),
  )

  const app = await startTestApp({ home })
  t.onTestFinished(() => app.close())

  const listed = await rpc(app.origin, "account.list", { provider: "buddy" })
  assert.equal(listed.ok, true)
  assert.equal(listed.value.accounts.length, 1, "账号索引应能读到")

  // ⚠️ 核心断言：`source` 有值 = 凭据真的解析到了。
  //    第一版的 bug 正是「账号在、source 为空」。
  const [account] = listed.value.accounts
  assert.equal(account.id, "buddy-seed01")
  assert.ok(
    account.source,
    `凭据应可读（source 非空），实际 source=${JSON.stringify(account.source)} —— 出现即说明凭据又读不到了`,
  )
  assert.equal(account.source, "file", "凭据应来自凭据文档")
})

test("关闭后不残留文件监听（否则 node --test 不退出）", async () => {
  const app = await startTestApp()
  await app.close()
  // 给 watcher 关闭留出一点时间（chokidar 的 close 是异步的）。
  await new Promise((resolve) => setTimeout(resolve, 600))
  const watchers = (process._getActiveHandles?.() ?? []).filter((handle) => handle.constructor?.name === "FSWatcher")
  assert.equal(
    watchers.length,
    0,
    `close() 后不应残留文件监听，实际 ${watchers.length} 个 —— 说明 dispose 没走到根 fiber`,
  )
})

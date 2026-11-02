/**
 * 给 codearts2api 挂「厂商模型清单 + 逐条开关」的幂等补丁（2026-11-02）。
 *
 * 用户需求（原文）：「我希望在左边厂商这里可以看到厂商的所有模型，以及模型状态，
 * 同时可以选择模型的启用状态，如果关闭的话则下游拉不到这个模型，同时也无法调用。」
 *
 * 改动全部是「如实代理上游已有的 RPC」，不自己造开关逻辑：
 *   - provider.status      → 每个厂商 {total, disabled, closed}
 *   - model.list           → 未过滤全量目录（含 disabled / dead 标记）
 *   - model.setDisabled    → 单条开关（布尔必填，上游不做默认值猜测）
 *   - model.setDisabledMany→ 全开/全关
 * 关掉的模型会经 llm.listModels() 的过滤链从 /v1/models 消失、推理也调不到
 * （已核对 collectGatewayCatalog 的 source.listModels 走的是过滤后目录）。
 *
 * 本脚本只做三件事（前端脚本由 admin.html 引 /admin/models-ui.js）：
 *   1. src/server.js  import 模型模块
 *   2. src/server.js  创建 modelsAdmin（紧跟 dashboard-admin 块之后，logger 已就绪）
 *   3. src/server.js  在 dashboardAdmin 分派之后加一行分派
 *   4. public/admin.html 注入 <script src="/admin/models-ui.js">
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.argv[2] ?? process.cwd()
const SERVER = join(ROOT, "src/server.js")
const ADMIN_HTML = join(ROOT, "public/admin.html")
const MODULE = join(ROOT, "src/models-admin.js")

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function backup(file) {
  const dst = `${file}.bak-models-${Date.now()}`
  copyFileSync(file, dst)
  console.log(`  备份：${dst}`)
}

function patch(file, marker, apply) {
  let src = readFileSync(file, "utf8")
  if (src.includes(marker)) {
    console.log(`  server.js: 已打过补丁（${marker}），跳过`)
    return false
  }
  const before = src
  src = apply(src)
  if (src === before) fail(`锚点未命中，补丁未生效：${marker}`)
  backup(file)
  writeFileSync(file, src)
  console.log(`  server.js: 已打补丁（${marker}）`)
  return true
}

console.log("[models] 1/5 检查文件")
if (!existsSync(SERVER)) fail(`找不到 ${SERVER}`)
if (!existsSync(MODULE)) fail(`找不到 ${MODULE} —— 先把 models-admin.js 传到 src/`)

// ── 0. 前置自检：依赖 dashboard-admin 的补丁点（models 紧随其后插入）────────
const serverSrc = readFileSync(SERVER, "utf8")
if (!serverSrc.includes("const dashboardAdmin = createDashboardAdmin")) {
  fail("找不到 dashboardAdmin 实例 —— 请先执行 patch-dashboard.mjs（本补丁复用它的 rpc 通道）")
}
if (!serverSrc.includes("      if (await dashboardAdmin.handle(request, response, url)) return")) {
  fail("找不到 dashboardAdmin 分派 —— 请先执行 patch-dashboard.mjs")
}

const modSrc = readFileSync(MODULE, "utf8")
for (const need of ["API_PATH", "UI_PATH", "UI_SRC", "createModelsAdmin"]) {
  if (!modSrc.includes(need)) fail(`src/models-admin.js 缺少导出 ${need}`)
}
console.log("  ✓ 模块导出齐全，dashboard 补丁已在位")

// ── 1. import ──────────────────────────────────────────────────────────
console.log("[models] 2/5 挂载 import + 实例 + 分派")
patch(SERVER, 'from "./models-admin.js"', (src) => {
  const anchor = 'import { createDashboardAdmin } from "./dashboard-admin.js"'
  if (!src.includes(anchor)) fail("找不到 dashboard-admin 的 import —— 上游锚点变了")
  return src.replace(anchor, `${anchor}\nimport { createModelsAdmin } from "./models-admin.js"`)
})

// ── 2. 创建实例 ────────────────────────────────────────────────────────
//
// 插在 dashboard-admin 块之后：那里 logger / JET_HUB_PATH / rpcEnvelope 都已就绪，
// 且不会踩到 TDZ（教训：实例声明早于 const logger = options.logger 会让服务
// active 但端口全不通）。
patch(SERVER, "const modelsAdmin = createModelsAdmin", (src) => {
  const anchor = "  // <<< dashboard-admin\n"
  if (!src.includes(anchor)) fail("找不到 dashboard-admin 块尾锚点")

  const insert = `${anchor}  // >>> models-admin
  // 厂商模型清单与逐条开关：只代理上游 RPC，不自己实现开关语义。
  // ⚠️ 与其他管理模块一样建在 adminKey 解析之后，靠 adminKey 打内部 RPC。
  const modelsAdmin = createModelsAdmin({
    rpc: async (method, payload) => {
      const route = host.routes.get(JET_HUB_PATH)
      if (route === undefined) throw new Error("jet-hub 路由未注册")
      const web = await route.fetch(
        new Request(\`http://127.0.0.1\${JET_HUB_PATH}\`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rpcEnvelope(method, payload ?? {}, "models")),
        }),
      )
      const parsed = await web.json()
      if (parsed?.result?.error !== undefined) throw new Error(String(parsed.result.error))
      if (parsed?.result?.value === undefined) throw new Error(parsed?.result?.message ?? "空响应")
      return parsed.result.value
    },
    logger,
  });
  // <<< models-admin
`
  return src.replace(anchor, insert)
})

// ── 3. 分派（紧跟 dashboardAdmin 之后）──────────────────────────────────
patch(SERVER, "modelsAdmin.handle", (src) => {
  const anchor = "      if (await dashboardAdmin.handle(request, response, url)) return"
  if (!src.includes(anchor)) fail("找不到 dashboardAdmin 分派锚点")
  const insert = `${anchor}
      // >>> models-admin
      if (await modelsAdmin.handle(request, response, url)) return
      // <<< models-admin`
  return src.replace(anchor, insert)
})

// ── 4. admin.html 注入 ─────────────────────────────────────────────────
console.log("[models] 3/5 注入 /admin 页面脚本")
const TAG = '<script src="/admin/models-ui.js"></script><!-- models-admin-entry -->'
if (!existsSync(ADMIN_HTML)) fail(`找不到 ${ADMIN_HTML}`)
{
  const html = readFileSync(ADMIN_HTML, "utf8")
  if (html.includes("<!-- models-admin-entry -->")) {
    console.log("  admin.html: 模型入口已存在，跳过")
  } else {
    const next = html.includes("</body>") ? html.replace("</body>", `${TAG}\n</body>`) : `${html}\n${TAG}`
    backup(ADMIN_HTML)
    writeFileSync(ADMIN_HTML, next)
    console.log("  admin.html: 已注入模型脚本")
  }
}

// ── 5. 自检 ────────────────────────────────────────────────────────────
console.log("[models] 4/5 自检")
const finalServer = readFileSync(SERVER, "utf8")
for (const need of ['from "./models-admin.js"', "createModelsAdmin({", "modelsAdmin.handle(request, response, url)"]) {
  if (!finalServer.includes(need)) fail(`server.js 缺少补丁片段：${need}`)
}
console.log("  ✓ server.js 三处补丁齐全")
const finalHtml = readFileSync(ADMIN_HTML, "utf8")
if (!finalHtml.includes("/admin/models-ui.js")) fail("admin.html 注入失败")
console.log("  ✓ admin.html 含 /admin/models-ui.js")

console.log("[models] 5/5 完成")
console.log("\n下一步：")
console.log("  export PATH=/www/server/nodejs/v24.22.2/bin:$PATH")
console.log("  node --check src/server.js && node --check src/models-admin.js")
console.log("  systemctl restart codearts2api")

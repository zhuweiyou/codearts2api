/**
 * 给 codearts2api 挂「总览看板」的幂等补丁（弹窗版，2026-11-02）。
 *
 * 设计约束（用户明确要求）：
 *   1. 不要独立 URL —— 看板不是 /admin/dashboard 独立页面，而是 /admin 里的一个模态框；
 *   2. 样式与原生一致 —— 前端复用 .dim-jh-modal / .dim-jh-btn 与 var(--dsw-alias-*)。
 *
 * 因此改动是：
 *   1. src/server.js  import 看板模块
 *   2. src/server.js  创建 dashboardAdmin（必须在 adminKey 解析之后）
 *   3. src/server.js  在 callerAdmin 分派之后加一行分派
 *   4. public/admin.html 注入 <script src="/admin/dashboard-ui.js">
 *
 * 依赖注入口径（照抄上游已有的 readGatewayState / providerIds 写法，不猜变量名）：
 *   - rpc：走 host.routes.get(JET_HUB_PATH).fetch(...) + rpcEnvelope(...)，
 *          与健康检查用的是同一条通道，天然带鉴权、不经过网络；
 *   - gateway：readGatewayState(host) + providerIds(host)，两个函数上游已存在。
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.argv[2] ?? process.cwd()
const SERVER = join(ROOT, "src/server.js")
const ADMIN_HTML = join(ROOT, "public/admin.html")
const MODULE = join(ROOT, "src/dashboard-admin.js")

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function backup(file) {
  const dst = `${file}.bak-dashboard-${Date.now()}`
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

console.log("[dashboard] 1/5 检查文件")
if (!existsSync(SERVER)) fail(`找不到 ${SERVER}`)
if (!existsSync(MODULE)) fail(`找不到 ${MODULE} —— 先把 dashboard-admin.js 传到 src/`)

// ── 0. 前置自检：模块必须是弹窗版 ──────────────────────────────────────
const modSrc = readFileSync(MODULE, "utf8")
if (modSrc.includes("PAGE_PATH")) {
  fail("src/dashboard-admin.js 还是旧版（含 PAGE_PATH，独立页面模式）—— 请先换成弹窗版")
}
for (const need of ["API_PATH", "UI_PATH", "UI_SRC", "createDashboardAdmin"]) {
  if (!modSrc.includes(need)) fail(`src/dashboard-admin.js 缺少导出 ${need}`)
}
console.log("  ✓ 模块是弹窗版，导出齐全")

// ── 1. import ──────────────────────────────────────────────────────────
console.log("[dashboard] 2/5 挂载 import + 实例 + 分派")
patch(SERVER, 'from "./dashboard-admin.js"', (src) => {
  const anchor = 'import { createCallerAdmin } from "./caller-admin.js"'
  if (!src.includes(anchor)) fail("找不到 createCallerAdmin 的 import —— 上游锚点变了")
  return src.replace(anchor, `${anchor}\nimport { createDashboardAdmin } from "./dashboard-admin.js"`)
})

// ── 2. 创建实例 ────────────────────────────────────────────────────────
//
// 依赖注入说明（全部复用上游已有能力，不自造通道）：
//   - dataDir：host.home，**本身就是 .../data**，模块内不能再 join("data")；
//   - rpc：与 readGatewayState 完全相同的路径 —— host.routes.get(JET_HUB_PATH).fetch，
//          不经过网络、天然带鉴权。看板只用它调 credits.balances 拿余额；
//   - gateway：readGatewayState(host) 的裁剪结果 + providerIds(host)。
patch(SERVER, "const dashboardAdmin = createDashboardAdmin", (src) => {
  const anchor = "  /** 登录失败限速（按来源 IP）。 */"
  if (!src.includes(anchor)) fail("找不到「登录失败限速」锚点 —— adminKey 初始化段变了")

  const insert = `  // >>> dashboard-admin
  // 总览看板：不占独立 URL，只提供 /admin/dashboard/api 与 /admin/dashboard-ui.js。
  // ⚠️ 必须建在 adminKey 解析之后 —— 看板靠 adminKey 打内部 RPC。
  // ⚠️ dataDir 就是 host.home，本身已经是 .../data。
  const dashboardAdmin = createDashboardAdmin({
    dataDir: host.home,
    rpc: async (method, payload) => {
      // 与 readGatewayState 同一条通道：直接打在插件路由上，不走网络。
      const route = host.routes.get(JET_HUB_PATH)
      if (route === undefined) throw new Error("jet-hub 路由未注册")
      const web = await route.fetch(
        new Request(\`http://127.0.0.1\${JET_HUB_PATH}\`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rpcEnvelope(method, payload ?? {}, "dashboard")),
        }),
      )
      const parsed = await web.json()
      if (parsed?.result?.error !== undefined) throw new Error(String(parsed.result.error))
      if (parsed?.result?.value === undefined) throw new Error(parsed?.result?.message ?? "空响应")
      return parsed.result.value
    },
    gateway: async () => {
      const state = await readGatewayState(host)
      return { ok: state?.running === true && state?.enabled !== false, gateway: state, providers: providerIds(host) }
    },
    logger,
  });
  // <<< dashboard-admin

${anchor}`
  return src.replace(anchor, insert)
})

// ── 3. 分派 ────────────────────────────────────────────────────────────
patch(SERVER, "dashboardAdmin.handle", (src) => {
  const anchor = "      if (await callerAdmin.handle(request, response, url)) return"
  if (!src.includes(anchor)) fail("找不到 callerAdmin 分派锚点")
  const insert = `${anchor}
      // >>> dashboard-admin
      if (await dashboardAdmin.handle(request, response, url)) return
      // <<< dashboard-admin`
  return src.replace(anchor, insert)
})

// ── 4. admin.html 注入 ─────────────────────────────────────────────────
console.log("[dashboard] 3/5 注入 /admin 页面脚本")
const TAG = '<script src="/admin/dashboard-ui.js"></script><!-- dashboard-admin-entry -->'
if (!existsSync(ADMIN_HTML)) fail(`找不到 ${ADMIN_HTML}`)
{
  const html = readFileSync(ADMIN_HTML, "utf8")
  if (html.includes("<!-- dashboard-admin-entry -->")) {
    console.log("  admin.html: 看板入口已存在，跳过")
  } else {
    const next = html.includes("</body>") ? html.replace("</body>", `${TAG}\n</body>`) : `${html}\n${TAG}`
    backup(ADMIN_HTML)
    writeFileSync(ADMIN_HTML, next)
    console.log("  admin.html: 已注入看板脚本")
  }
}

// ── 5. 自检 ────────────────────────────────────────────────────────────
console.log("[dashboard] 4/5 自检")
const finalServer = readFileSync(SERVER, "utf8")
for (const need of [
  'from "./dashboard-admin.js"',
  "createDashboardAdmin({",
  "dashboardAdmin.handle(request, response, url)",
]) {
  if (!finalServer.includes(need)) fail(`server.js 缺少补丁片段：${need}`)
}
console.log("  ✓ server.js 三处补丁齐全")
const finalHtml = readFileSync(ADMIN_HTML, "utf8")
if (!finalHtml.includes("/admin/dashboard-ui.js")) fail("admin.html 注入失败")
console.log("  ✓ admin.html 含 /admin/dashboard-ui.js")

console.log("[dashboard] 5/5 完成")
console.log("\n下一步：")
console.log("  export PATH=/www/server/nodejs/v24.22.2/bin:$PATH")
console.log("  node --check src/server.js && node --check src/dashboard-admin.js")
console.log("  systemctl restart codearts2api")

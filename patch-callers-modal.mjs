/**
 * 把「调用方管理」从独立页 `/admin/callers` 改成 `/admin` 里的原生弹窗。
 *
 * ## 改什么
 *
 *   1. `src/server.js` import `createCallersUiHandler`
 *   2. `src/server.js` 创建实例 + 分派（紧跟 dashboardAdmin 之后）
 *   3. `public/admin.html` 注入 `<script src="/admin/callers-ui.js">`
 *   4. **摘掉** `patch-caller-link.mjs` 留下的旧跳转链接注入（`/admin/callers-link.js`）
 *
 * ## 为什么第 4 步要做
 *
 * 旧的 `caller-link.js` 往 header 插的是 `<a href="/admin/callers">调用方管理</a>`（点走跳页）。
 * 新的 `callers-ui.js` 插的是 `<button>调用方</button>`（原地弹窗）。两个都在，
 * header 上就会出现两个功能重复的入口。这里把旧那条 `<script>` 一并从 admin.html 摘掉 ——
 * 后端 `/admin/callers` 页面本身**不删**，留着当兜底（弹窗坏了还能直接访问）。
 *
 * ## 执行顺序
 *
 * 必须在 `patch-caller-admin.mjs` **之后**跑：本脚本要确保 caller-admin 后端已挂上
 * （``/admin/callers/api`` 是弹窗的唯一数据源）。
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.argv[2] ?? process.cwd()
const SERVER = join(ROOT, "src/server.js")
const ADMIN_HTML = join(ROOT, "public/admin.html")
const MODULE = join(ROOT, "src/callers-ui.js")

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function backup(file) {
  const dst = `${file}.bak-callers-ui-${Date.now()}`
  copyFileSync(file, dst)
  console.log(`  备份：${dst}`)
}

function patch(file, marker, apply, label) {
  const src = readFileSync(file, "utf8")
  if (src.includes(marker)) {
    console.log(`  ${label}: 已打过，跳过`)
    return
  }
  const next = apply(src)
  if (next === src) fail(`${label}: 锚点未命中，补丁未生效`)
  backup(file)
  writeFileSync(file, next)
  console.log(`  ${label}: 已打补丁`)
}

console.log("[callers-ui] 1/5 检查文件")
if (!existsSync(SERVER)) fail(`找不到 ${SERVER}`)
if (!existsSync(MODULE)) fail(`找不到 ${MODULE} —— 先把它传到 src/`)

const serverSrc = readFileSync(SERVER, "utf8")
// 前置自检：弹窗的数据源必须已在
if (!serverSrc.includes("createCallerAdmin")) {
  fail("server.js 里没有 createCallerAdmin —— 先跑 patch-caller-admin.mjs，否则弹窗没有数据源")
}
console.log("  ✓ caller-admin 后端已在")

// ── 1. import ──────────────────────────────────────────────────────────
console.log("[callers-ui] 2/5 挂载 import + 实例 + 分派")
patch(
  SERVER,
  'from "./callers-ui.js"',
  (src) => {
    const anchor = 'import { createDashboardAdmin } from "./dashboard-admin.js"'
    if (!src.includes(anchor)) fail("找不到 createDashboardAdmin 的 import —— 先跑 patch-dashboard.mjs")
    return src.replace(anchor, `${anchor}\nimport { createCallersUiHandler } from "./callers-ui.js"`)
  },
  "import",
)

// ── 2. 创建实例 + 分派 ─────────────────────────────────────────────────
patch(
  SERVER,
  "callersUiHandler",
  (src) => {
    const anchor = "      // <<< dashboard-admin"
    if (!src.includes(anchor)) fail("找不到 dashboard-admin 补丁块的结尾锚点")

    const insert = `${anchor}
      // >>> callers-ui
      // 调用方管理的弹窗 UI 脚本（数据仍走 /admin/callers/api，不重复实现后端）。
      if (callersUiHandler(request, response, url)) return
      // <<< callers-ui`

    // 实例声明插在看板实例之后（依赖 logger 已就绪）
    const withHandler = `  const callersUiHandler = createCallersUiHandler();\n`
    const mark = "  // <<< dashboard-admin\n"
    const idx = src.indexOf(mark)
    const declAt = idx + mark.length
    const srcWithDecl = src.slice(0, declAt) + withHandler + src.slice(declAt)

    // 分派插在看板分派块之后
    return srcWithDecl.replace(anchor, insert)
  },
  "实例+分派",
)

// ── 3. admin.html 注入 ─────────────────────────────────────────────────
console.log("[callers-ui] 3/5 注入 /admin 页面脚本")
const TAG = '<script src="/admin/callers-ui.js"></script><!-- callers-ui-entry -->'
{
  const html = readFileSync(ADMIN_HTML, "utf8")
  if (html.includes("<!-- callers-ui-entry -->")) {
    console.log("  admin.html: 入口已存在，跳过")
  } else {
    const next = html.includes("</body>") ? html.replace("</body>", `${TAG}\n</body>`) : `${html}\n${TAG}`
    backup(ADMIN_HTML)
    writeFileSync(ADMIN_HTML, next)
    console.log("  admin.html: 已注入 callers-ui.js")
  }
}

// ── 4. 摘掉旧的跳转链接注入 ────────────────────────────────────────────
console.log("[callers-ui] 4/5 摘掉旧的跳转链接（避免 header 出现两个入口）")
{
  const html = readFileSync(ADMIN_HTML, "utf8")
  // 匹配 patch-caller-link.mjs 注入的那一行（含它的标记注释），整行删掉
  const re = /^.*<!--\s*caller-admin-entry\s*-->.*\n?/m
  const m = re.exec(html)
  if (!m) {
    console.log("  admin.html: 没有旧链接注入（或已被摘），跳过")
  } else {
    const next = html.replace(re, "")
    backup(ADMIN_HTML)
    writeFileSync(ADMIN_HTML, next)
    console.log(`  admin.html: 已摘掉旧链接行 → ${m[0].trim().slice(0, 80)}`)
  }
}

// ── 5. 自检 ────────────────────────────────────────────────────────────
console.log("[callers-ui] 5/5 自检")
const finalServer = readFileSync(SERVER, "utf8")
for (const need of [
  'from "./callers-ui.js"',
  "const callersUiHandler = createCallersUiHandler()",
  "if (callersUiHandler(request, response, url)) return",
]) {
  if (!finalServer.includes(need)) fail(`server.js 缺少片段：${need}`)
}
console.log("  ✓ server.js 三处齐全")

const finalHtml = readFileSync(ADMIN_HTML, "utf8")
if (!finalHtml.includes("/admin/callers-ui.js")) fail("admin.html 缺少 callers-ui.js")
if (finalHtml.includes("caller-admin-entry")) fail("admin.html 仍留着旧跳转链接 —— 第 4 步没生效")
console.log("  ✓ admin.html 只有新入口，旧链接已摘")

console.log("[callers-ui] 完成")
console.log("\n下一步：")
console.log("  export PATH=/www/server/nodejs/v24.22.2/bin:$PATH")
console.log("  node --check src/server.js && node --check src/callers-ui.js")
console.log("  systemctl restart codearts2api")

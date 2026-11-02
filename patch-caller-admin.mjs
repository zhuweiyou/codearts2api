/**
 * 给 `src/server.js` 接入 `/admin/callers` 网页管理面。
 *
 * 幂等：三处补丁都带 `// >>> caller-admin` / `// <<< caller-admin` 标记，
 * 已经打过就直接跳过；锚点找不到就报错退出（宁可不动，也不要在错误的位置插代码）。
 *
 * 用法：node patch-caller-admin.mjs [--revert]
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const TARGET = join(ROOT, "src", "server.js")
const MARK = "// >>> caller-admin"

if (!existsSync(TARGET)) {
  console.error(`找不到 ${TARGET}`)
  process.exit(1)
}

let source = readFileSync(TARGET, "utf8")
const original = source
const revert = process.argv.includes("--revert")

function once(label, needle, apply) {
  const count = source.split(needle).length - 1
  if (count === 0) {
    throw new Error(`锚点「${label}」没找到——上游可能改过了，先别改，人看一眼`)
  }
  if (count > 1) {
    throw new Error(`锚点「${label}」出现 ${count} 次，不唯一，拒绝猜`)
  }
  source = source.replace(needle, apply)
}

try {
  if (revert) {
    const blocks = [
      /\n *\/\/ >>> caller-admin[\s\S]*?\/\/ <<< caller-admin\n/g,
      /\n *\/\/ >>> caller-admin-import[\s\S]*?\/\/ <<< caller-admin-import\n/g,
    ]
    let removed = 0
    for (const re of blocks) {
      const hits = source.match(re) ?? []
      removed += hits.length
      source = source.replace(re, "\n")
    }
    console.log(`已移除 ${removed} 段 shellock`)
  } else {
    // ── 1) import ──
    if (!source.includes(`${MARK}-import`)) {
      once(
        "admin-login-page import",
        'import { renderLoginPage, sanitizeNext } from "./admin-login-page.js"',
        (hit) =>
          `${hit}\n${MARK}-import\nimport { createCallerAdmin } from "./caller-admin.js"\n// <<< caller-admin-import`,
      )
    }

    // ── 2) 实例化 ──
    //
    // ⚠️ 必须插在 `const logger = options.logger` **之后**。第一版把这段放在
    //    callerGate 那行后面，而 logger 声明在更下面 → 启动即
    //    `ReferenceError: Cannot access 'logger' before initialization`（TDZ），
    //    systemd 一直 auto-restart，表现为「service active 但端口不通」。
    if (!source.includes(`${MARK}\n`)) {
      once(
        "logger 声明",
        "  const logger = options.logger",
        (hit) =>
          `${hit}\n${MARK}\n  // 管理面（分组 / key / 白名单）。` +
          `\n  // 只做 CRUD 与页面渲染，不参与 /v1 热路径。鉴权由下面的管理端鉴权门负责。` +
          `\n  const callerAdmin = createCallerAdmin({ home: host.home, logger });` +
          `\n// <<< caller-admin`,
      )
    }

    // ── 3) 分发 ──
    if (!source.includes(`${MARK}-dispatch`)) {
      once(
        "管理端鉴权门",
        `      if (adminKeyEnabled() && needsAdminAuth(path) && !isAdminAuthorized(request, adminKey)) {
        respondUnauthorized(request, response, url)
        return
      }`,
        (hit) =>
          `${hit}\n\n      ${MARK}-dispatch` +
          `\n      // 调用方管理页（/admin/callers）。放在鉴权门之后 = 未登录会被 302 到登录页。` +
          `\n      if (await callerAdmin.handle(request, response, url)) return` +
          `\n      // <<< caller-admin`,
      )
    }
  }

  if (source === original) {
    console.log("已是目标状态，未改动。")
    process.exit(0)
  }

  const backup = `${TARGET}.bak-caller-admin-${Date.now()}`
  copyFileSync(TARGET, backup)
  writeFileSync(TARGET, source)
  console.log(`${revert ? "已回滚" : "已打补丁"}：${TARGET}`)
  console.log(`备份：${backup}`)
} catch (error) {
  console.error(`✗ ${error.message}`)
  console.error("文件未改动。")
  process.exit(1)
}

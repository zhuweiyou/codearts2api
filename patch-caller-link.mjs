/**
 * 在管理后台的静态壳 `public/admin.html` 末尾挂上「调用方管理」入口脚本。
 *
 * 为什么改这个文件而不是改 UI bundle：
 *   `public/upstream-jet-hub.js` 是 768 KB 的构建产物、还被 .gitignore 了，改它
 *   下次 npm run build 就没了；`admin.html` 是仓库里的静态壳，加一行 <script>
 *   是最小的、可重复的改动点。真正的落点逻辑在 `src/caller-admin.js` 的 LINK_JS 里，
 *   这部分只负责「把脚本引进来」。
 *
 * 幂等：已经挂过就跳过；--revert 摘掉。
 *
 * 用法：node patch-caller-link.mjs [--revert]
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
const TARGET = join(ROOT, "public", "admin.html")
const ANCHOR = '    <script src="/admin.js"></script>'
const INJECT = '    <script src="/admin/callers-link.js"></script>'
const MARK = "<!-- caller-admin-entry -->"

if (!existsSync(TARGET)) {
  console.error(`找不到 ${TARGET}`)
  process.exit(1)
}

const original = readFileSync(TARGET, "utf8")
let source = original
const revert = process.argv.includes("--revert")

try {
  if (revert) {
    source = source.replace(`\n${MARK}\n${INJECT}`, "")
    source = source.replace(`${INJECT}\n`, "")
  } else {
    if (source.includes(INJECT)) {
      console.log("入口脚本已挂过，未改动。")
      process.exit(0)
    }
    if (!source.includes(ANCHOR)) {
      throw new Error(`锚点「${ANCHOR.trim()}」没找到——上游可能改过 admin.html，人看一眼`)
    }
    if (source.split(ANCHOR).length - 1 > 1) {
      throw new Error("锚点不唯一，拒绝猜")
    }
    // ⚠️ 放最末：必须在上游三个 script 之后，否则它会在 admin-root 还没渲染时跑
    source = source.replace(ANCHOR, `${ANCHOR}\n${MARK}\n${INJECT}`)
  }

  if (source === original) {
    console.log("已是目标状态，未改动。")
    process.exit(0)
  }

  const backup = `${TARGET}.bak-caller-link-${Date.now()}`
  copyFileSync(TARGET, backup)
  writeFileSync(TARGET, source)
  console.log(`${revert ? "已摘掉入口" : "已挂入口"}：${TARGET}`)
  console.log(`备份：${backup}`)
} catch (error) {
  console.error(`✗ ${error.message}`)
  console.error("文件未改动。")
  process.exit(1)
}

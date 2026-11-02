/**
 * 给 codearts2api 接入 OAuth 回调中继（`/relay/<port>/<path>` + `/admin/oauth-relay/replay`）。
 *
 * 幂等：三处 server.js 补丁各带独立标记 `// >>> oauth-relay{,-import,-dispatch}`，
 * 已经打过就跳过；锚点找不到或出现多次就报错退出（宁可不动，也不要在错的位置插代码）。
 * admin.html 单独一处追加 script 标签。
 *
 * 用法：node patch-oauth-relay.mjs [--revert]
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL(".", import.meta.url))
const SERVER = join(ROOT, "src", "server.js")
const ADMIN_HTML = join(ROOT, "public", "admin.html")
const SCRIPT_TAG = '<script src="/admin/oauth-relay-ui.js"></script><!-- oauth-relay-entry -->'

for (const file of [SERVER, ADMIN_HTML]) {
  if (!existsSync(file)) {
    console.error(`找不到 ${file}`)
    process.exit(1)
  }
}

const revert = process.argv.includes("--revert")
const backups = []

/**
 * 在 text 里把 needle 换成 make(needle)，且要求 needle 恰好出现一次。
 * 纯函数式：返回新字符串，不依赖外层变量（早先版本因为参数名遮蔽，改动被静默丢弃过）。
 */
function swapOnce(text, label, needle, make) {
  const count = text.split(needle).length - 1
  if (count === 0) throw new Error(`锚点「${label}」没找到——上游可能改过了，先别改，人看一眼`)
  if (count > 1) throw new Error(`锚点「${label}」出现 ${count} 次，不唯一，拒绝猜`)
  return text.replace(needle, () => make(needle))
}

function commit(file, original, next) {
  if (next === original) {
    console.log(`${file} 已是目标状态，未改动。`)
    return
  }
  const backup = `${file}.bak-oauth-relay-${Date.now()}`
  copyFileSync(file, backup)
  writeFileSync(file, next)
  backups.push(backup)
  console.log(`${revert ? "已回滚" : "已打补丁"}：${file}`)
}

try {
  // ─────────── server.js ───────────
  {
    const file = SERVER
    const original = readFileSync(file, "utf8")
    let text = original

    if (revert) {
      // ⚠️ 三个标记互为前缀：每个正则都要边界，避免 `oauth-relay` 把
      //    `oauth-relay-import` / `oauth-relay-dispatch` 一起吃掉。
      const blocks = [
        [/\n *\/\/ >>> oauth-relay-import(?!-)[\s\S]*?\/\/ <<< oauth-relay-import(?!-)\n/g, "import"],
        [/\n *\/\/ >>> oauth-relay-dispatch(?!-)[\s\S]*?\/\/ <<< oauth-relay-dispatch(?!-)\n/g, "dispatch"],
        [/\n *\/\/ >>> oauth-relay(?!-)[\s\S]*?\/\/ <<< oauth-relay(?!-)\n/g, "构造"],
      ]
      for (const [re, label] of blocks) {
        const hits = (text.match(re) ?? []).length
        text = text.replace(re, "\n")
        console.log(`server.js 移除 ${label} 段：${hits}`)
      }
    } else {
      // 1) import：必须自成一对标记，且插在 `// <<< caller-admin-import` **之后**。
      //    插进 caller-admin 块内部会被它的 --revert 惰性整块正则一起删掉。
      if (!text.includes("// >>> oauth-relay-import")) {
        text = swapOnce(
          text,
          "caller-admin-import 块尾",
          "// <<< caller-admin-import",
          (hit) =>
            `${hit}\n// >>> oauth-relay-import\n` +
            `import { createOAuthRelay } from "./oauth-relay.js"\n` +
            `// <<< oauth-relay-import`,
        )
        console.log("server.js 已插入 import")
      } else {
        console.log("server.js import 已存在，跳过")
      }

      // 2) 实例化：锚点用 `// <<< caller-admin\n  const adminAuthEnabled`。
      //    裸 `// <<< caller-admin` 会撞到 `-import` 变体、出现多次。
      if (!/\/\/ >>> oauth-relay(?!-)/.test(text)) {
        text = swapOnce(
          text,
          "caller-admin 构造块尾",
          "// <<< caller-admin\n  const adminAuthEnabled",
          () =>
            `// <<< caller-admin\n// >>> oauth-relay\n` +
            `  // OAuth 回调中继：把上游硬绑 127.0.0.1:<端口> 的登录页/回调搬到 /relay/<port>/*。\n` +
            `  // 只在本机回环上取数，且整段挂在管理端鉴权门之后（未登录一律 401/302）。\n` +
            `  const oauthRelay = createOAuthRelay({ logger });\n` +
            `// <<< oauth-relay\n  const adminAuthEnabled`,
        )
        console.log("server.js 已插入实例化")
      } else {
        console.log("server.js 实例化已存在，跳过")
      }

      // 3) 分发：接在 caller-admin 分发包之后、Jet Hub RPC 段之前。
      if (!text.includes("// >>> oauth-relay-dispatch")) {
        text = swapOnce(
          text,
          "caller-admin 分发包尾 + Jet Hub RPC 段首",
          "// <<< caller-admin\n\n      // ── Jet Hub 管理 RPC（透传给插件）──",
          () =>
            `// <<< caller-admin\n\n      // >>> oauth-relay-dispatch\n` +
            `      // OAuth 回调中继（/relay/<port>/* 与 /admin/oauth-relay/replay）。\n` +
            `      // 同样在鉴权门之后：/relay/* 必须登录，否则等于把本机 OAuth 监听器暴露到公网。\n` +
            `      if (await oauthRelay.handle(request, response, url)) return\n` +
            `      // <<< oauth-relay-dispatch\n\n      // ── Jet Hub 管理 RPC（透传给插件）──`,
        )
        console.log("server.js 已插入分发")
      } else {
        console.log("server.js 分发已存在，跳过")
      }
    }

    commit(file, original, text)
  }

  // ─────────── public/admin.html ───────────
  {
    const file = ADMIN_HTML
    const original = readFileSync(file, "utf8")
    let text = original

    if (revert) {
      text = text
        .split("\n")
        .filter((line) => line.trim() !== SCRIPT_TAG)
        .join("\n")
    } else if (!text.includes(SCRIPT_TAG)) {
      // 锚点：models-admin-entry 那行（唯一）。原文缩进本就不统一，不要顺手统一。
      text = swapOnce(
        text,
        "models-admin-entry 标签",
        '<script src="/admin/models-ui.js"></script><!-- models-admin-entry -->',
        (hit) => `${hit}\n${SCRIPT_TAG}`,
      )
    }

    commit(file, original, text)
  }

  console.log(backups.length === 0 ? "全部已是目标状态。" : `备份：\n  ${backups.join("\n  ")}`)
} catch (error) {
  console.error(`✗ ${error.message}`)
  console.error("已写出的文件保留备份，未写出的文件未改动。")
  process.exit(1)
}

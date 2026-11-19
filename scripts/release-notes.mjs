/**
 * 生成一次发布（GitHub Release）的正文。
 *
 * 规则：
 * - 取「上一个 tag（HEAD 之前最近的一个）→ HEAD」之间的提交（不含 merge）；
 * - 每个提交列一行标题；
 * - 只有「自动升级」那条（标题含 `自动升级`，或 body 含自动生成标记），把它 commit body
 *   里「上游改动」下的逐条 `- xxx` 作为子级缩进展开（与旧 CHANGELOG 的写法一致）；
 *   合并 PR 的提交只留标题。
 *
 * 用法：`node scripts/release-notes.mjs`（stdout 即 Markdown 正文）。
 */
import { execFileSync } from "node:child_process"

const UPSTREAM = "iJetLi/dsh-providers-hub"

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" })
}

// 上游 commit 标题里的 `#123` 指的是**上游仓库**的 issue/PR；在 Release 正文里若不前缀仓库，
// GitHub 会把它错链到本仓库的 #123。前缀 `owner/repo#123` 后 GitHub 才会正确跨仓链接。
// （只对「上游改动」子项用；本仓库 PR 标题里的编号保持原样。）
function linkUpstreamRefs(text) {
  return text.replace(/(?<![\w/])#(\d+)\b/g, `${UPSTREAM}#$1`)
}

let prev = ""
try {
  prev = git(["describe", "--tags", "--abbrev=0", "HEAD^"]).trim()
} catch {
  // HEAD 没有父提交（首个提交）：回退到全历史
}

const range = prev ? `${prev}..HEAD` : "HEAD"
let raw = ""
try {
  raw = git(["log", "--no-merges", "--format=%s%x1f%b%x1e", range])
} catch {
  raw = ""
}

const lines = []
for (const rec of raw.split("\x1e")) {
  if (!rec.trim()) continue
  const sep = rec.indexOf("\x1f")
  const subject = (sep >= 0 ? rec.slice(0, sep) : rec).trim()
  const body = sep >= 0 ? rec.slice(sep + 1) : ""
  if (!subject) continue
  if (subject.startsWith("Merge pull request") || subject.startsWith("Merge branch")) continue

  lines.push("- " + subject)

  const isUpgrade = subject.includes("自动升级") || body.includes("由 scripts/upgrade-upstream.mjs 自动生成")
  if (!isUpgrade) continue

  let dep = ""
  const subs = []
  let grab = false
  for (const b of body.split(/\r?\n/)) {
    const s = b.trim()
    if (s.startsWith("依赖")) {
      dep = s.replace(/^依赖[:：]?/, "").trim()
      continue
    }
    if (s.startsWith("上游改动")) {
      grab = true
      continue
    }
    if (grab) {
      if (s.startsWith("- ")) subs.push(s.slice(2).trim())
      else if (s === "") continue
      else break
    }
  }
  if (dep) lines.push("  - 依赖：" + dep)
  for (const t of subs) lines.push("  - " + linkUpstreamRefs(t))
}

if (lines.length === 0) lines.push("（本次发布没有可列的提交）")
process.stdout.write(lines.join("\n") + "\n")

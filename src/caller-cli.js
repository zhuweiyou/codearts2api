/**
 * caller-cli.js — 调用方 key / 分组的命令行管理
 *
 * 用法（在应用目录下跑）：
 *   node src/caller-cli.js init
 *   node src/caller-cli.js list
 *   node src/caller-cli.js groups
 *   node src/caller-cli.js group-add --name vip --allow "codearts/*,qodercn/qmodel_38max" [--deny "aggregate/*"]
 *   node src/caller-cli.js group-rm --name vip
 *   node src/caller-cli.js add --name 张三 --group basic [--id k_zhangsan]
 *   node src/caller-cli.js disable --id k_zhangsan
 *   node src/caller-cli.js enable  --id k_zhangsan
 *   node src/caller-cli.js rm --id k_zhangsan
 *   node src/caller-cli.js usage [--day 2026-10-29] [--id k_zhangsan]
 *
 * 新增 key 时明文只打印一次；文件里存 sha256，明文不落盘。
 */

import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const HOME = process.env.CODEARTS2API_HOME || resolve(process.cwd(), "data")
const STORE = join(HOME, "caller-keys.json")
const LOG_DIR = join(HOME, "caller-usage")

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex")

/** 与上游网关同构：32 字节 base64url = 43 字符。客户端无需区分两种 key。 */
const newKey = () => randomBytes(32).toString("base64url")

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item.startsWith("--")) {
      const name = item.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) out[name] = true
      else {
        out[name] = next
        i += 1
      }
    } else out._.push(item)
  }
  return out
}

function load() {
  if (!existsSync(STORE)) {
    console.error(`找不到 ${STORE}\n先跑：node src/caller-cli.js init`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(STORE, "utf8"))
}

function save(data) {
  writeFileSync(STORE, `${JSON.stringify(data, null, 2)}\n`, "utf8")
}

function mask(digest) {
  return digest ? `${digest.slice(0, 8)}…${digest.slice(-4)}` : "-"
}

function todayLog(day) {
  const file = join(LOG_DIR, `${day}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

const cmd = process.argv[2]
const args = parseArgs(process.argv.slice(3))

switch (cmd) {
  case "init": {
    if (existsSync(STORE)) {
      console.log(`已存在，未覆盖：${STORE}`)
      break
    }
    mkdirSync(HOME, { recursive: true })
    save({
      version: 1,
      _comment:
        "groups[].allow / deny 支持 `*`、`provider/*`、完整模型名。aggregate/* 与 jet-hub-auto/* 在白名单不是 * 时必须显式列出才可用。",
      groups: [
        { name: "full", desc: "全部模型", allow: ["*"] },
        {
          name: "basic",
          desc: "常规对话模型（不含聚合路由）",
          allow: ["codearts/*", "qodercn/gmodel", "qodercn/kmodel", "qodercn/kmodel_latest", "zcode/*"],
        },
        { name: "codearts-only", desc: "仅华为云码道", allow: ["codearts/*"] },
      ],
      keys: [],
    })
    console.log(`已创建 ${STORE}`)
    break
  }

  case "list": {
    const data = load()
    const groups = new Map((data.groups ?? []).map((g) => [g.name, g]))
    console.log(`分组 ${groups.size} 个 / key ${(data.keys ?? []).length} 把\n`)
    for (const key of data.keys ?? []) {
      const group = groups.get(key.group)
      const allow = group ? (group.allow ?? []).join(", ") : "（分组缺失）"
      console.log(
        `${key.enabled === false ? "○" : "●"} ${String(key.id).padEnd(16)} ${String(key.name).padEnd(12)} ` +
          `group=${String(key.group).padEnd(14)} sha=${mask(key.sha256)}`,
      )
      console.log(`    allow: ${allow}`)
    }
    break
  }

  case "groups": {
    const data = load()
    for (const group of data.groups ?? []) {
      console.log(`${group.name}${group.desc ? `  — ${group.desc}` : ""}`)
      console.log(`    allow: ${(group.allow ?? []).join(", ") || "（空 = 全部拒绝）"}`)
      if (group.deny?.length) console.log(`    deny : ${group.deny.join(", ")}`)
    }
    break
  }

  case "group-add":
  case "group-update": {
    const name = String(args.name ?? "").trim()
    if (!name) {
      console.error("缺 --name")
      process.exit(2)
    }
    const data = load()
    data.groups ??= []
    const allow = args.allow
      ? String(args.allow)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []
    const deny = args.deny
      ? String(args.deny)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []
    const existing = data.groups.find((g) => g.name === name)
    if (existing) {
      existing.allow = allow
      existing.deny = deny
      if (args.desc) existing.desc = String(args.desc)
      console.log(`已更新分组 ${name}`)
    } else {
      data.groups.push({ name, desc: args.desc ? String(args.desc) : "", allow, deny })
      console.log(`已新增分组 ${name}`)
    }
    save(data)
    break
  }

  case "group-rm": {
    const name = String(args.name ?? "").trim()
    const data = load()
    const used = (data.keys ?? []).filter((k) => k.group === name).length
    if (used) {
      console.error(`分组 ${name} 还被 ${used} 把 key 使用，先改绑再删。`)
      process.exit(3)
    }
    data.groups = (data.groups ?? []).filter((g) => g.name !== name)
    save(data)
    console.log(`已删除分组 ${name}`)
    break
  }

  case "add": {
    const name = String(args.name ?? "").trim()
    const group = String(args.group ?? "").trim()
    if (!name || !group) {
      console.error("缺 --name 或 --group")
      process.exit(2)
    }
    const data = load()
    const groupExists = (data.groups ?? []).some((g) => g.name === group)
    if (!groupExists) {
      console.error(`分组 ${group} 不存在。现有：${(data.groups ?? []).map((g) => g.name).join(", ")}`)
      process.exit(3)
    }
    const plain = newKey()
    const id = String(args.id ?? `k_${randomBytes(3).toString("hex")}`)
    data.keys ??= []
    if (data.keys.some((k) => k.id === id)) {
      console.error(`key id ${id} 已存在`)
      process.exit(4)
    }
    data.keys.push({ id, name, group, sha256: sha256(plain), enabled: true, createdAt: new Date().toISOString() })
    save(data)
    console.log(`已新增 ${id}（${name} / ${group}）\n`)
    console.log(`  key = ${plain}`)
    console.log("\n这串只显示这一次。立刻告诉对方，别存进仓库/聊天记录。")
    break
  }

  case "enable":
  case "disable": {
    const id = String(args.id ?? "").trim()
    const data = load()
    const key = (data.keys ?? []).find((k) => k.id === id)
    if (!key) {
      console.error(`没有 ${id}`)
      process.exit(4)
    }
    key.enabled = cmd === "enable"
    save(data)
    console.log(`${id} → ${key.enabled ? "启用" : "停用"}`)
    break
  }

  case "rm": {
    const id = String(args.id ?? "").trim()
    const data = load()
    const before = (data.keys ?? []).length
    data.keys = (data.keys ?? []).filter((k) => k.id !== id)
    save(data)
    console.log(before === data.keys.length ? `没有 ${id}` : `已删除 ${id}`)
    break
  }

  case "usage": {
    const day = String(args.day ?? new Date().toISOString().slice(0, 10))
    const rows = todayLog(day)
    if (!rows.length) {
      console.log(`${day} 没有调用记录（${join(LOG_DIR, `${day}.jsonl`)}）`)
      break
    }
    const wanted = args.id ? rows.filter((r) => r.caller === args.id) : rows
    const byCaller = new Map()
    const byModel = new Map()
    for (const row of wanted) {
      const c = byCaller.get(row.caller ?? "-") ?? { req: 0, tokIn: 0, tokOut: 0, err: 0, names: new Set() }
      c.req += 1
      c.tokIn += row.in_tokens ?? 0
      c.tokOut += row.out_tokens ?? 0
      if (row.status >= 400) c.err += 1
      c.names.add(row.name ?? "")
      byCaller.set(row.caller ?? "-", c)

      const m = byModel.get(row.model ?? "-") ?? { req: 0, tok: 0 }
      m.req += 1
      m.tok += (row.in_tokens ?? 0) + (row.out_tokens ?? 0)
      byModel.set(row.model ?? "-", m)
    }
    console.log(`${day}  调用 ${wanted.length} 次\n`)
    console.log("按调用方：")
    for (const [caller, v] of [...byCaller].sort((a, b) => b[1].req - a[1].req)) {
      console.log(
        `  ${caller.padEnd(16)} ${String(v.req).padStart(5)} 次  in=${String(v.tokIn).padStart(8)}  out=${String(v.tokOut).padStart(8)}  错误=${v.err}`,
      )
    }
    console.log("\n按模型：")
    for (const [model, v] of [...byModel].sort((a, b) => b[1].req - a[1].req)) {
      console.log(`  ${String(model).padEnd(40)} ${String(v.req).padStart(5)} 次  tok=${v.tok}`)
    }
    break
  }

  case "days": {
    if (!existsSync(LOG_DIR)) {
      console.log("还没有用量日志")
      break
    }
    for (const file of readdirSync(LOG_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()) {
      console.log(file.replace(/\.jsonl$/, ""))
    }
    break
  }

  default:
    console.log(
      [
        "调用方 key / 分组管理",
        "",
        "  init                                    建配置文件（含 3 个示例分组）",
        "  list / groups                           看 key / 看分组",
        "  add --name 张三 --group basic           新增 key（明文只打印一次）",
        "  disable|enable --id k_xxx               停用 / 启用",
        "  rm --id k_xxx                           删除",
        '  group-add --name vip --allow "codearts/*,qodercn/gmodel" [--deny ...]',
        "  group-rm --name vip",
        "  usage [--day YYYY-MM-DD] [--id k_xxx]   用量汇总",
        "  days                                    有日志的日期",
      ].join("\n"),
    )
}

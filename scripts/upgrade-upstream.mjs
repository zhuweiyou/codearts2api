/**
 * 上游依赖自动升级脚本。
 *
 * ## 它做什么
 *
 * 1. 查上游 `dsh-providers-hub` 的 `main` 最新 commit；
 * 2. **hash 没变就直接跳过**（不装、不构建、不改文件、不提交）—— 这是最重要的一条，
 *    每天定时任务绝大多数时候都会走到这里；
 * 3. 有更新则：改 `package.json` → `npm install` → `npm run build` → 跑测试 →
 *    把上游这一段的 **commit 标题**写进 `CHANGELOG.md` → `git commit`；
 * 4. 任何一步失败都**非零退出**，把日志留在 stderr 里（GitHub Actions 会因此发失败通知）。
 *
 * ## 为什么 CHANGELOG 只写标题
 *
 * 上游每个 commit 的正文动辄几百行（实测有上千行的），自动抄进来只会把 CHANGELOG
 * 变成流水账。**标题**才是有信息量的那一行（`feat(x): 新增 …` / `fix(y): 修 …`），
 * 也正好够回答「这次上游改了什么」。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/upgrade-upstream.mjs              # 完整跑
 * node scripts/upgrade-upstream.mjs --dry-run    # 只查不装，看上游有没有新 commit
 * node scripts/upgrade-upstream.mjs --no-commit  # 跑完不提交（自己看 diff）
 * ```
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const UPSTREAM_URL = "https://github.com/zhuweiyou/dsh-providers-hub.git"
const UPSTREAM_BRANCH = "main"
const DEP_NAME = "dsh-providers-hub"

/**
 * DSH 基础包的包名前缀。
 *
 * ⚠️ 这些包的版本**必须整族一致**，原因是它们互相之间是**精确** peer
 *    （`dsh-commands@0.2.1-rc.2` 硬要 `dsh-llm@0.2.1-rc.2`），而上游 hub 对它们的
 *    peer 范围是**一串旧版本或起来**（`^0.1.2-rc.1 || … || ^0.2.1-rc.2`）。
 *    npm 装 peer 时取的是「范围内**最新**」那一版 ⇒ 只要 DSH 发了新 rc，
 *    装进来就是「一半新、一半旧」，直接 ERESOLVE（2026-10-24 那次定时任务就是这么挂的：
 *    `dsh-commands` 没在根依赖里钉，npm 自己装了 rc.3，而根依赖钉的是 rc.2）。
 *
 *    所以**凡是被上游列为必需 peer 的基础包，都必须在 `package.json` 里显式钉住**。
 */
const BASE_PACKAGE_PREFIX = "@deepseek-ai/dsh-"

/**
 * 自动升级 commit 的署名。
 *
 * ⚠️ 与 `.github/workflows/upgrade-upstream.yml` 里的 git 配置**必须一致** ——
 *    否则本机跑出来的 commit 与 CI 跑出来的署名不同，看着像两个人干的。
 *    用「机器人」名而不是个人名，是为了在提交历史里一眼看出是自动升级。
 */
const BOT_NAME = "upgrade-bot"
const BOT_EMAIL = "upgrade-bot@users.noreply.github.com"

const args = new Set(process.argv.slice(2))
const dryRun = args.has("--dry-run")
const noCommit = args.has("--no-commit")

// ── 小工具 ──

/**
 * 跑一条命令并返回 stdout（失败时抛错，stderr 直接透出）。
 *
 * ⚠️ **npm / npx 在 Windows 上不能直接 spawn** —— 这是两个坑叠在一起：
 *
 *  1. `npm` 是 `npm.cmd` 批处理，`spawn` 它会 ENOENT；
 *  2. 就算补上 `.cmd` 后缀，Node ≥ 18.20/20.12/22 也**拒绝** spawn `.cmd`
 *     （CVE-2024-27980 的修复，`spawnSync npm.cmd EINVAL`）—— 除非开 `shell: true`；
 *  3. 而 `shell: true` 会让参数**不被转义**地拼进 shell 命令行（Node 发 DEP0190
 *     警告），本脚本的 commit message 是多行中文，拼进去等于交给 shell 解析。
 *
 * ✅ **正解：用 `process.execPath`（当前 node 可执行文件）直接跑 npm 的 JS 入口**
 *    （`<npm 前缀>/node_modules/npm/bin/npm-cli.js`）。这样既不用 shell，也没有
 *    `.cmd` 的限制，Windows 与 Linux 行为一致。
 *
 * ⚠️ 当调用方把 stdout 设成 `"inherit"`（让用户实时看到输出）时，Node **不返回**
 *    任何 stdout（是 `null`）—— 这时不能对它调 `.trim()`，否则会抛
 *    `Cannot read properties of null`。这坑踩过一次：npm install 明明成功了，
 *    却因为返回值是 null 而被当成失败。
 */
function run(command, commandArgs, options = {}) {
  const output = execFileSync(...resolveInvocation(command, commandArgs), {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  })
  return typeof output === "string" ? output.trim() : ""
}

/**
 * 把「命令名 + 参数」翻译成 `execFileSync` 真正要执行的「可执行文件 + 参数」。
 *
 * 只有 npm 系（npm / npx）走 JS 入口；git 之类的原生可执行文件原样调用
 * （Windows 上 git 是 `git.exe`，能直接 spawn）。
 */
function resolveInvocation(command, commandArgs) {
  if (command === "npm" || command === "npx") {
    const cli = npmCliPath(command)
    if (cli) {
      return [process.execPath, [cli, ...commandArgs]]
    }
  }
  return [command, commandArgs]
}

/**
 * 找到 npm 的 CLI 入口（`npm-cli.js` / `npx-cli.js`）。
 *
 * 定位方式：先看 `npm` 可执行文件旁边的 `node_modules/npm/bin/`，再看全局
 * `npm root -g` 指向的目录。找不到就返回 null —— 那样会退回直接 spawn，
 * 在 Windows 上大概率失败，但至少报错信息是「找不到 npm」而不是莫名 EINVAL。
 */
function npmCliPath(kind) {
  const fileName = kind === "npx" ? "npx-cli.js" : "npm-cli.js"
  const candidates = []
  // ① node 可执行文件所在目录（标准安装：<prefix>/node_modules/npm/bin/）
  const nodeDir = dirname(process.execPath)
  candidates.push(join(nodeDir, "node_modules", "npm", "bin", fileName))
  // ② 全局 npm root
  //
  // ⚠️ 这里**不能**用 `tryRun("npm", …)` —— 那会绕回 `resolveInvocation` →
  //    `npmCliPath`，**无限递归**。所以直接找目录，不去执行 npm。
  for (const globalRoot of globalNpmRoots()) {
    candidates.push(join(globalRoot, "npm", "bin", fileName))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 猜全局 npm 的安装根目录（不执行 npm，避免递归）。
 *
 * 常见位置：
 *   · Windows：%APPDATA%\npm\node_modules
 *   · POSIX：  $PREFIX/lib/node_modules
 * 找不到就返回空数组 —— 那时 `npmCliPath` 靠 ① 的路径（标准安装必中）就够了。
 */
function globalNpmRoots() {
  const roots = []
  const appData = process.env.APPDATA
  if (appData) {
    roots.push(join(appData, "npm", "node_modules"))
  }
  const prefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX
  if (prefix) {
    roots.push(join(prefix, "lib", "node_modules"))
    roots.push(join(prefix, "node_modules"))
  }
  return roots
}

/** 跑一条命令，失败时返回 null 而不是抛错（用于「可失败」的探测）。 */
function tryRun(command, commandArgs, options = {}) {
  try {
    return run(command, commandArgs, options)
  } catch {
    return null
  }
}

/**
 * 删一个文件 / 目录，失败不抛错（清理是尽力而为的事）。
 *
 * 用 Node 的 fs API 而不是 `rm -rf` / `del /f` —— 后者在两个平台上的语法都不同
 * （`cmd /c rmdir /s /q` 是 Windows 专有，`rm -rf` 在 Windows 上不存在）。
 */
function removeFile(path) {
  try {
    rmSync(path, { force: true })
  } catch {
    // 清理失败无害。
  }
}

function removeDir(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // 清理失败无害（目录已进 .gitignore）。
  }
}

function log(message) {
  console.log(`[upgrade] ${message}`)
}

function fail(message, error) {
  console.error(`[upgrade] ❌ ${message}`)
  if (error) {
    console.error(`[upgrade] ---- 错误详情 ----`)
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  }
  process.exitCode = 1
}

// ── ① 读当前锁定版本 ──

const packageJsonPath = join(root, "package.json")
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))
const currentSpec = packageJson.dependencies?.[DEP_NAME]
if (!currentSpec) {
  fail(`package.json 里没有 ${DEP_NAME} 依赖，无法自动升级`)
  process.exit(1)
}

/** 从 `git+<url>#<hash>` 里抠出 hash。 */
function hashOf(spec) {
  const match = /#([0-9a-f]{7,40})$/.exec(spec ?? "")
  return match ? match[1] : null
}

const currentHash = hashOf(currentSpec)
if (!currentHash) {
  fail(`无法从依赖声明里解析出当前 commit：${currentSpec}`)
  process.exit(1)
}
log(`当前锁定：${currentHash}`)

// ⚠️ **一致性自检**：package.json 与 package-lock.json 记的 hash 必须一致。
//
//    这是上一轮失败留下的半成品状态会引发的**死锁**：package.json 已经是新 hash
//    （但 install 没成功），lock 还是旧的 —— 下次跑脚本会看到「package.json 的 hash
//    == 上游最新」而误判「没有更新」直接跳过，于是**这个仓库再也升不上去了**。
//
//    检测到不一致就报出来（并给出修法），而不是闷头跳过。
{
  const lockNow = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"))
  const lockedNow = lockNow.packages?.[`node_modules/${DEP_NAME}`]?.resolved ?? ""
  const lockedHash = hashOf(lockedNow)
  if (lockedHash && lockedHash !== currentHash) {
    fail(
      `package.json 与 package-lock.json 记的上游 commit 不一致：\n` +
        `  package.json：${currentHash}\n  package-lock：${lockedHash}\n` +
        "这通常是上一次升级中途失败留下的半成品状态。修法：\n" +
        `  git checkout -- package.json package-lock.json\n` +
        `  node scripts/upgrade-upstream.mjs`,
    )
    process.exit(1)
  }
}

// ── ② 查上游最新 commit ──

log(`查询上游 ${UPSTREAM_URL} 的 ${UPSTREAM_BRANCH} …`)
const lsRemote = tryRun("git", ["ls-remote", UPSTREAM_URL, `refs/heads/${UPSTREAM_BRANCH}`])
if (!lsRemote) {
  fail(`无法访问上游仓库（git ls-remote 失败）：${UPSTREAM_URL}`)
  process.exit(1)
}
const latestHash = lsRemote.split(/\s+/)[0]
if (!latestHash) {
  fail(`上游 ls-remote 没有返回 ${UPSTREAM_BRANCH} 分支`)
  process.exit(1)
}
log(`上游最新：${latestHash}`)

// ── ③ hash 没变 → 跳过（绝大多数时候走这里）──

if (latestHash === currentHash || latestHash.startsWith(currentHash) || currentHash.startsWith(latestHash)) {
  log("上游没有新 commit —— 跳过，不装、不构建、不提交。")
  process.exit(0)
}

log(`发现新上游版本：${currentHash} → ${latestHash}`)
if (dryRun) {
  log("--dry-run：到此为止，不做任何改动。")
  process.exit(0)
}

/** 根依赖里钉住的 DSH 基础包，返回 `name@version` 列表（用于报错时当场摊开）。 */
function pinnedBasePackages() {
  return Object.entries(packageJson.dependencies ?? {})
    .filter(([name]) => name.startsWith(BASE_PACKAGE_PREFIX))
    .map(([name, version]) => `${name}@${version}`)
}

/**
 * 扫 `package-lock.json`，收集每个 `@deepseek-ai/dsh-*` 的实际安装版本。
 *
 * 用来兜住「不报错、但装歪了」的情况：npm 偶尔能把版本不同的基础包**都装下来**
 * （各自满足各自的 peer），听起来能跑，实际是两套互不相认的实例 ——
 * 典型症状是「服务明明装了、`ctx.get()` 却拿不到」。
 */
function installedBaseVersions() {
  const lockNow = JSON.parse(readFileSync(lockPath, "utf8"))
  const versions = new Map()
  for (const [key, entry] of Object.entries(lockNow.packages ?? {})) {
    const match = /node_modules\/(@deepseek-ai\/dsh-[^/]+)$/.exec(key)
    if (!match) continue
    if (!versions.has(match[1])) versions.set(match[1], new Set())
    versions.get(match[1]).add(entry.version)
  }
  return versions
}

// ── ④ 改 package.json 并安装 ──
//
// ⚠️ **顺序很重要**：先把原文件内容备份起来，失败时**回滚**，别留下半成品状态。
//    （早期版本是「先改 package.json 再 install」，install 失败就留下了
//     「package.json 是新的、lock 和 node_modules 是旧的」这种不一致状态，
//     下次再跑脚本会因为 hash 已经写进去而误判「没有更新」从而跳过 ——
//     那样这个仓库就再也升不上去了。）
const packageJsonBackup = readFileSync(packageJsonPath, "utf8")
const lockPath = join(root, "package-lock.json")
const lockBackup = readFileSync(lockPath, "utf8")

/** 把 package.json / package-lock.json 恢复成升级前的样子。 */
function restoreManifests() {
  try {
    writeFileSync(packageJsonPath, packageJsonBackup, "utf8")
    writeFileSync(lockPath, lockBackup, "utf8")
    log("已回滚 package.json / package-lock.json 到升级前状态。")
  } catch (error) {
    console.error(`[upgrade] ❌ 回滚失败，请手工检查 ${packageJsonPath} 与 ${lockPath}`)
    console.error(error instanceof Error ? error.message : String(error))
  }
}

const newSpec = `git+${UPSTREAM_URL}#${latestHash}`
packageJson.dependencies[DEP_NAME] = newSpec
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")
log(`已更新 package.json：${newSpec}`)

try {
  log("npm install（会 clone 上游并现场编译它的 lib/，可能要几分钟）…")
  run("npm", ["install", `${DEP_NAME}@${newSpec}`, "--include=dev", "--no-audit", "--no-fund"], {
    stdio: ["ignore", "inherit", "inherit"],
    // ⚠️ **pnpm 11 的「新包冷却期」必须放行**：它默认拒绝装发布不足 24 小时的包，
    //    而上游会把它**刚发布**的 DSH 基础包（`@deepseek-ai/dsh-*`）写进自己的
    //    `pnpm-lock.yaml` ⇒ 上游 prepare 阶段直接失败：
    //    `The lockfile contains entries that the active policies reject …`。
    //    上游每次发版后约 24 小时内都会这样。
    //
    //    这里**自己带上**这个环境变量，而不是指望调用方（CI 的 job env、本机的
    //    shell）设好了 —— 否则「本机能装、CI 装不上」这类差异极难排查。
    //    只有这个**环境变量**能穿透到 npm 拉起的 pnpm 子进程（`.npmrc` 与
    //    `npm_config_*` 均无效）。
    env: { ...process.env, PNPM_CONFIG_MINIMUM_RELEASE_AGE: "0" },
  })
} catch (error) {
  restoreManifests()
  fail("npm install 失败（上游仓库拉取或编译出错？）", error)
  // ⚠️ 把「基础包版本打架」这个最常见的原因**当场摊开**，别让人对着 ERESOLVE 的一坨
  //    依赖树猜。判定见上面 BASE_PACKAGE_PREFIX 的注释：上游放宽 peer 范围后，npm
  //    会自动装「范围内最新」的那一版，与本仓库钉住的版本对不上。
  log("当前根依赖钉住的 DSH 基础包：")
  for (const spec of pinnedBasePackages()) log(`  · ${spec}`)
  log(
    "若报错是 ERESOLVE / peer 冲突：上游把 DSH 基础包的 peer 范围放宽后，npm 会自己装" +
      "「范围内最新」的那一版（只钉 rc.2、却装进 rc.3 的 dsh-commands 就是这么来的），" +
      "与本仓库钉的版本打架。修法：把上游列为**必需 peer**、而本仓库没钉的基础包补进" +
      "package.json，并**钉到与其它基础包同一个版本**，然后重跑本脚本。",
  )
  process.exit(1)
}

// ⚠️ 必须核对 lock 里的 resolved —— 只改 package.json 再 install 会**静默沿用旧 commit**
//    （README「升级流程」第 2 步那个坑）。这里当场验，不等到 CI 里才发现。
const lock = JSON.parse(readFileSync(lockPath, "utf8"))
const lockedResolved = lock.packages?.[`node_modules/${DEP_NAME}`]?.resolved ?? ""
if (!lockedResolved.endsWith(latestHash)) {
  restoreManifests()
  fail(
    `package-lock.json 里记的还是旧 commit：\n  期望结尾：${latestHash}\n  实际是：${lockedResolved}\n` +
      "（lock 静默沿用了旧版本。手工修：把两个文件的 hash 都改成新的，然后 rm -rf node_modules/dsh-providers-hub && npm install）",
  )
  process.exit(1)
}
log("package-lock.json 的 resolved 已核对一致 ✓")

// ⚠️ **基础包整族同版本自检**：装完立刻验，不等到运行时才露馅。
//
//    上一步的 ERESOLVE 是「打架到装不上」，这里防的是「没打架、但装了两套」：
//    不同版本的基础包各自满足各自的精确 peer 时会**共存**，看着装成功了，
//    实际是两个互不相认的实例（`ctx.get('llm')` 拿到 null 这类怪症状）。
{
  const versions = installedBaseVersions()
  const distinct = [...new Set([...versions.values()].flatMap((set) => [...set]))]
  if (distinct.length > 1) {
    const detail = [...versions].map(([name, set]) => `  · ${name}：${[...set].join(" / ")}`).join("\n")
    fail(
      `DSH 基础包装成了多个版本（必须整族一致）：\n${detail}\n` +
        "这通常是「上游把它列为 peer、而本仓库没钉住」的包被 npm 装成了最新版。修法：\n" +
        "  · 把上面出现两个版本的那个包补进 package.json，钉到与其它基础包同一个版本；\n" +
        "  · 然后 rm -rf node_modules package-lock.json && npm install（干净重装再验一次）。",
    )
    process.exit(1)
  }
  if (distinct.length === 1) {
    log(`DSH 基础包整族同版本 ✓（${distinct[0]}，共 ${versions.size} 个）`)
  }
}

// ⚠️ npm 11 会把 GitHub 的 git 依赖在 lock 里**规范化成 `git+ssh://git@github.com/…`**，
//    而手工装的时候用的其实还是原来的 https —— 也就是说这个 ssh 写法纯属「写回去的
//    格式」，但**下一次干净安装会照着它走 ssh**：CI / Docker 里没有 SSH 私钥，直接
//    clone 失败。所以每次升级后都把 lock 里的写法改回 https 再提交。
const lockText = readFileSync(lockPath, "utf8")
const lockAsHttps = lockText.replaceAll("git+ssh://git@github.com/", "git+https://github.com/")
if (lockAsHttps !== lockText) {
  writeFileSync(lockPath, lockAsHttps, "utf8")
  log("已把 package-lock.json 里的 git+ssh 写法改回 git+https（npm 11 的规范化，CI 无密钥会失败）")
}

// ── ⑤ 重建前端产物 ──

try {
  log("npm run build …")
  run("npm", ["run", "build"], { stdio: ["ignore", "inherit", "inherit"] })
} catch (error) {
  fail("npm run build 失败（上游产物形态变了？）", error)
  process.exit(1)
}

// ── ⑥ 测试与规范 ──
//
// ⚠️ `format:check` 放在**写 CHANGELOG 之前**跑：等 CHANGELOG 写完再检查，它必然
//    会因为「自动生成的格式与 Prettier 不一致」而红 —— 那是脚本自己造的噪音，
//    会让每次自动升级都失败。第 ⑦ 步写完 CHANGELOG 后会**自动格式化**它。
for (const [label, command, commandArgs] of [
  ["npm test", "npm", ["test"]],
  ["npm run lint", "npm", ["run", "lint"]],
  ["npm run format:check", "npm", ["run", "format:check"]],
]) {
  try {
    log(`${label} …`)
    run(command, commandArgs, { stdio: ["ignore", "inherit", "inherit"] })
  } catch (error) {
    fail(`${label} 失败 —— 需要人工处理`, error)
    process.exit(1)
  }
}

// ── ⑦ 把上游这一段的 commit 标题写进 CHANGELOG ──

/**
 * 取上游 `old..new` 之间的 commit 标题（**只要标题，不要正文**）。
 *
 * 用一次浅克隆到临时目录来做，避免污染本仓库的 git 状态。
 * 克隆失败（网络抖动等）不该让整个升级失败 —— 那时退回「只记 hash」。
 */
function upstreamCommitTitles(from, to) {
  const cloneDir = join(root, ".upgrade-upstream-tmp")
  try {
    run("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", UPSTREAM_URL, cloneDir], {
      stdio: ["ignore", "pipe", "inherit"],
    })
    // ⚠️ 上游若**重写历史**（force-push / 重新打一次 release commit），我们锁的旧 hash
    //    就不在分支上了，`from..to` 这段区间无从比较（git 报 unknown revision）。
    //    此时退回「只取最新那一个 commit 的标题」，别让整个升级因此失败。
    let output
    try {
      output = run("git", ["log", "--format=%s", "--no-merges", `${from}..${to}`], { cwd: cloneDir })
    } catch {
      output = run("git", ["log", "--format=%s", "--no-merges", "-1", to], { cwd: cloneDir })
    }
    return (
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        // ⚠️ `--no-merges` 只能滤掉**有两个 parent** 的 merge commit。上游的 PR 是
        //    **squash merge**（压成一个 commit、只有一个 parent），标题形如
        //    `Merge PR !119 (!119 feat/xxx) into pr131-merge` —— 那种是 PR 的**元信息**，
        //    不是一次真实的改动，记进 CHANGELOG 只会是噪音，按标题过滤掉。
        .filter((title) => !/^Merge PR !\d+/i.test(title))
    )
  } catch (error) {
    fail(`拉取上游 commit 标题失败（将只记录 hash）：${error instanceof Error ? error.message : error}`)
    return []
  } finally {
    // 清理临时克隆（失败无害 —— 目录已加进 .gitignore，留着也不影响仓库）。
    tryRun("git", ["-C", cloneDir, "clean", "-fdx"], { stdio: "ignore" })
    removeDir(cloneDir)
  }
}

const titles = upstreamCommitTitles(currentHash, latestHash)
log(`上游本段共 ${titles.length} 个 commit（不含 merge）`)

/**
 * 把标题里的 HTML 敏感字符转义掉，免得破坏 CHANGELOG 的上下文。
 *
 * 只转义 `<` / `>` / `&`：标题里出现的 `&`、`<`、`>` 在 Markdown 正文里会被
 * 当成 HTML 标签解析，转成实体最省事。**反引号不用管** —— 标题写在正文里
 * （不是 `<summary>`），那里反引号照常渲染成行内代码。
 */
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** 北京时间（UTC+8）的日期，上游升级记录按本地日历记。 */
function beijingDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

const changelogPath = join(root, "CHANGELOG.md")
const changelog = readFileSync(changelogPath, "utf8")
const today = beijingDate()

const titleList = titles.length
  ? titles.map((title) => `- ${escapeHtml(title)}`).join("\n")
  : "- （未取到上游 commit 标题，请人工查阅上游仓库）"

const entry = [
  "<details open>",
  `<summary><b>${today} · 上游升级 <code>${latestHash.slice(0, 7)}</code>（自动升级）</b></summary>`,
  "",
  "## 上游升级",
  "",
  `依赖从 \`${currentHash}\` 更新到 \`${latestHash}\`。`,
  "",
  "### 上游改动",
  "",
  titleList,
  "",
  "</details>",
  "",
  "",
].join("\n")

// 插到文件顶部：第一个 `<details` 之前（`<details open>` 归上一条）。
const marker = "<details"
const index = changelog.indexOf(marker)
if (index === -1) {
  fail("CHANGELOG.md 里找不到 <details> 标记，无法插入新条目")
  process.exit(1)
}

// 新条目自己带 `open`，旧的**去掉** `open`（只有最新一条默认展开）。
const head = changelog.slice(0, index)
const tail = changelog.slice(index).replace("<details open>", "<details>")
writeFileSync(changelogPath, `${head}${entry}${tail}`, "utf8")
log("已写入 CHANGELOG.md")

// ⚠️ 自动格式化刚写进去的 CHANGELOG —— 否则它的格式（行宽、列表缩进）多半与
//    Prettier 的约定不一致，下次 `npm run format:check` 就会红。
//    只格式化这一个文件，不碰仓库里其它文件（那会把「本来没动过」的文件也重写）。
try {
  log("格式化 CHANGELOG.md …")
  run("npx", ["prettier", "--write", "CHANGELOG.md"], { stdio: ["ignore", "inherit", "inherit"] })
} catch (error) {
  fail("格式化 CHANGELOG.md 失败", error)
  process.exit(1)
}

// 再验一次格式（确认自动生成的东西确实合规）。
try {
  log("复核 format:check …")
  run("npm", ["run", "format:check"], { stdio: ["ignore", "inherit", "inherit"] })
} catch (error) {
  fail("format:check 失败（自动生成的 CHANGELOG 不合规？）", error)
  process.exit(1)
}

// ── ⑧ 提交 ──

if (noCommit) {
  log("--no-commit：改动已留在工作区，未提交。")
  process.exit(0)
}

try {
  run("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md"], { stdio: ["ignore", "inherit", "inherit"] })
  const message = [
    `chore: 升级上游到 ${latestHash.slice(0, 7)}（自动升级）`,
    "",
    `依赖：${currentHash} → ${latestHash}`,
    "",
    "上游改动：",
    ...titles.map((title) => `- ${title}`),
    "",
    "由 scripts/upgrade-upstream.mjs 自动生成。",
  ].join("\n")
  // ⚠️ commit message 必须走 **`-F 文件`**，不能用 `-m "多行文本"`：
  //    多行 message 里有换行与中文，交给任何一层做引号处理都容易出错 ——
  //    早期版本用 `shell: true` + `-m`，shell 把多行 message 按换行拆成多个参数，
  //    git 于是把后面的行当成**路径**（报 `pathspec '升级上游到' did not match`）。
  //    写成文件最稳，跨平台且不受引号/换行影响。
  const messageFile = join(root, ".upgrade-commit-msg.tmp")
  writeFileSync(messageFile, message, "utf8")
  try {
    // ⚠️ **用 `git -c user.name=… -c user.email=…` 只给这一次提交指定身份**，
    //    **绝不**用 `git config user.name …` —— 那会**永久改掉仓库级配置**，
    //    于是你本机之后所有真人提交都会署名成机器人（这个坑踩过）。
    //
    //    `-c` 是「本次命令临时覆盖」，不写盘、跑完就没了；仓库与全局配置都不受影响。
    run("git", ["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "commit", "-F", messageFile], {
      stdio: ["ignore", "inherit", "inherit"],
    })
  } finally {
    removeFile(messageFile)
  }
  log("已提交 ✓")
} catch (error) {
  fail("git commit 失败", error)
  process.exit(1)
}

log(`升级完成：${currentHash} → ${latestHash}`)

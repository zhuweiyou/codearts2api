/**
 * patch-caller-gate.mjs — 把 caller-gate 接进 codearts2api 的 /v1 反代
 *
 * 幂等：已打过补丁就跳过（靠 `// >>> caller-gate` 标记识别）。
 * 失败即退出，不写半成品。
 *
 * 用法（在应用目录下）：
 *   node patch-caller-gate.mjs --check     只看会改什么
 *   node patch-caller-gate.mjs             真改
 */

import { copyFileSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const DRY = process.argv.includes("--check")
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)

const read = (p) => readFileSync(join(ROOT, p), "utf8")

function write(p, text, label) {
  if (!DRY) {
    copyFileSync(join(ROOT, p), join(ROOT, `${p}.bak-caller-${stamp}`))
    writeFileSync(join(ROOT, p), text, "utf8")
  }
  console.log(`${DRY ? "[dry] " : ""}${label}  ->  ${p}`)
}

/** 在最后一个 import 之后插入若干行 */
function afterLastImport(src, lines) {
  // 注意：本仓库不同文件的分号风格不一致（server.js 带分号，index.js 不带），
  // 所以这里不能要求行尾分号。
  const imports = [...src.matchAll(/^import .+$/gm)]
  if (!imports.length) throw new Error("找不到任何 import 语句")
  const last = imports[imports.length - 1]
  const at = last.index + last[0].length
  return `${src.slice(0, at)}\n${lines.join("\n")}${src.slice(at)}`
}

function patchServer() {
  let src = read("src/server.js")
  if (src.includes("// >>> caller-gate")) {
    console.log("src/server.js 已打过补丁，跳过")
    return
  }
  const before = src

  // 1) 选项
  const anchor1 = "  const proxyGateway = options.proxyGateway === true"
  if (!src.includes(anchor1)) throw new Error("找不到 proxyGateway 选项读取行")
  src = src.replace(
    anchor1,
    `${anchor1}\n  // >>> caller-gate\n  const callerGate = options.callerGate ?? null;\n  // <<< caller-gate`,
  )

  // 2) 反代前插闸门
  const anchor2 = `    const method = request.method ?? "GET"
    const hasBody = method !== "GET" && method !== "HEAD"`
  if (!src.includes(anchor2)) throw new Error("找不到 method/hasBody 计算行")
  src = src.replace(
    anchor2,
    `${anchor2}

    // >>> caller-gate
    let gateEntry = null;
    let gateModel;
    let gateBody;
    if (callerGate) {
      const verdict = await callerGate.inspect(request, url, method);
      if (!verdict.ok) {
        callerGate.sendJson(response, verdict.status ?? 403, { error: verdict.error });
        return;
      }
      if (!verdict.disabled) {
        gateEntry = verdict.entry ?? null;
        gateModel = verdict.model;
        gateBody = verdict.body;
        const upstreamKey = callerGate.upstreamKey();
        if (upstreamKey) headers.set("authorization", \`Bearer \${upstreamKey}\`);
        if (gateEntry?.id) headers.set("x-caller-id", String(gateEntry.id));
      }
    }
    // <<< caller-gate`,
  )

  // 3) 请求体用缓冲后的 Buffer
  const anchor3 = "        body: hasBody ? request : undefined,"
  if (!src.includes(anchor3)) throw new Error("找不到 body 透传行")
  src = src.replace(anchor3, "        body: gateBody ?? (hasBody ? request : undefined),")

  // 4) /v1/models 按分组过滤
  const anchor4 = `    const outHeaders = {}
    upstream.headers.forEach((value, key) => {`
  if (!src.includes(anchor4)) throw new Error("找不到 outHeaders 构造段")
  src = src.replace(
    anchor4,
    `    // >>> caller-gate
    if (callerGate && gateEntry && url.pathname === "/v1/models" && upstream.ok) {
      try {
        const payload = await upstream.json();
        callerGate.sendJson(response, 200, callerGate.filterModels(payload, gateEntry));
        return;
      } catch {
        /* 解析失败就退回原始流 */
      }
    }
    // <<< caller-gate

    const outHeaders = {}
    upstream.headers.forEach((value, key) => {`,
  )

  // 5) 响应流 tap（记账）
  const anchor5 = `    stream.on("error", () => response.destroy())
    stream.pipe(response)`
  if (!src.includes(anchor5)) throw new Error("找不到 stream.pipe 段")
  src = src.replace(
    anchor5,
    `    stream.on("error", () => response.destroy())
    // >>> caller-gate
    const outStream = callerGate
      ? callerGate.tapStream(stream, {
          status: upstream.status,
          callerId: gateEntry?.id,
          callerName: gateEntry?.name,
          callerGroup: gateEntry?.group,
          model: gateModel,
          path: url.pathname,
          stream: String(upstream.headers.get("content-type") ?? "").includes("event-stream"),
        })
      : stream;
    outStream.pipe(response);
    // <<< caller-gate`,
  )

  if (src === before) throw new Error("没有任何改动，检查锚点")
  write("src/server.js", src, "已给 /v1 反代接入调用方闸门")
}

function patchIndex() {
  let src = read("src/index.js")
  if (src.includes("// >>> caller-gate")) {
    console.log("src/index.js 已打过补丁，跳过")
    return
  }

  // 需要的运行时导入
  const need = []
  if (!/from "node:path"/.test(src)) need.push('import { join as joinPath } from "node:path";')
  if (!/from "node:fs"/.test(src)) need.push('import { readFileSync as readFileSyncNode } from "node:fs";')
  if (!src.includes('from "./caller-gate.js"')) need.push('import { createCallerGate } from "./caller-gate.js";')
  if (need.length) src = afterLastImport(src, need)

  const anchor1 = "const proxyGateway = resolveProxyGateway()"
  if (!src.includes(anchor1)) throw new Error("index.js 里找不到 resolveProxyGateway()")
  src = src.replace(
    anchor1,
    `${anchor1}

// >>> caller-gate
// data/caller-keys.json 不存在时闸门自动关闭，行为与改造前一致。
const callerGate = createCallerGate({
  home: host.home,
  logger: console,
  upstreamKey: () => {
    const fromEnv = process.env.DSH_OPENAI_GATEWAY_API_KEY;
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    try {
      return readFileSyncNode(joinPath(host.home, "openai-gateway", "api-key"), "utf8").trim();
    } catch {
      return null;
    }
  },
});
// <<< caller-gate`,
  )

  const anchor2 = "const server = createHttpServer(host, { logger: console, proxyGateway, adminAuth })"
  if (!src.includes(anchor2)) throw new Error("index.js 里找不到 createHttpServer 调用")
  src = src.replace(
    anchor2,
    "const server = createHttpServer(host, { logger: console, proxyGateway, adminAuth, callerGate })",
  )

  write("src/index.js", src, "已创建 callerGate 并注入 server")
}

try {
  patchServer()
  patchIndex()
  console.log("\n下一步：node --check src/server.js && node --check src/index.js")
} catch (error) {
  console.error(`\n失败：${error.message}`)
  console.error("该文件未改动。")
  process.exit(1)
}

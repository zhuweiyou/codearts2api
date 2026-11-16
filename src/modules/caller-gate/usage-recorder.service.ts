import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Transform } from "node:stream"

/** 用量记录：把一次调用的结果异步写入 caller-usage/<UTC+8 日期>.jsonl，并在响应流上边转发边采集 usage。 */
export function createUsageRecorder({
  logDir,
  logger,
  isEnabled,
}: {
  logDir: string
  logger?: any
  isEnabled: () => boolean
}) {
  // 异步写 + 串行队列：不阻塞事件循环，同时保证同一进程内写入有序、不交叉。
  // 返回 Promise，便于测试/调用方在需要时 await（服务热路径不 await）。
  let logChain = Promise.resolve()
  function log(entry) {
    const line = `${JSON.stringify(entry)}\n`
    logChain = logChain.then(async () => {
      try {
        await mkdir(logDir, { recursive: true })
        // 目录按人眼里的「今天」分文件；用 UTC 会让 UTC+8 的 00:00-08:00 记到前一天。
        const now = new Date()
        const day =
          String(now.getFullYear()) +
          "-" +
          String(now.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(now.getDate()).padStart(2, "0")
        await appendFile(join(logDir, `${day}.jsonl`), line, "utf8")
      } catch (error) {
        logger?.warn?.(`[caller-gate] 写用量日志失败：${String(error)}`)
      }
    })
    return logChain
  }

  /**
   * 响应流侧回调：边透传边解析用量，结束时写一条日志。不改变字节流本身。
   *
   * 两类响应分开处理，避免「正文里出现 usage/error 字样」被误判：
   * - 流式（SSE，ctx.stream=true）：按 `data:` 帧逐条 JSON.parse，只看**帧顶层**的
   *   `usage` 与 `error`。上游常是「HTTP 200 + 帧内 error」（限流/被拦），必须据此
   *   把这次请求记成失败，否则会冒充成功、污染用量与筛选。
   * - 非流式：整段 JSON 里窗口匹配 `"usage"`（纯数值对象，安全），状态沿用 HTTP 状态。
   */
  function tapStream(source, ctx) {
    // 闸门没开（没有 store）就直接把原流交回去，一个字节都不多碰。
    // ⚠️ 这里读的是 `inspect()` 刚刚刷新的缓存，不再发一次 I/O：
    //    tapStream 是同步的（要求它返回可 pipe 的流），而读盘已经全部异步化。
    if (!isEnabled()) return source
    const startedAt = Number.isFinite(ctx.startedAt) ? ctx.startedAt : Date.now()
    const isStream = Boolean(ctx.stream)
    let status = ctx.status ?? 200
    let usage = null
    let streamError = null
    let tail = "" // 非流式：窗口匹配用
    let frameBuf = "" // 流式：SSE 帧缓冲

    const takeUsage = (obj) => {
      if (obj && typeof obj === "object" && obj.usage && typeof obj.usage === "object") usage = obj.usage
    }

    // 非流式：从整段 JSON 文本里抓 `"usage":{...}`。usage 是纯数值对象，
    // 不含「字符串值里的花括号」，括号配平足够安全。
    const grabUsage = () => {
      const at = tail.lastIndexOf('"usage"')
      if (at < 0) return
      const start = tail.indexOf("{", at)
      if (start < 0) return
      let depth = 0
      for (let i = start; i < tail.length; i++) {
        const c = tail[i]
        if (c === "{") depth++
        else if (c === "}") {
          depth--
          if (depth === 0) {
            try {
              const o = JSON.parse(tail.slice(start, i + 1))
              if (o && typeof o === "object") usage = o
            } catch {
              /* 半截 JSON，忽略 */
            }
            return
          }
        }
      }
    }

    // 流式：只在凑够完整帧（出现空行）时才处理，避免每个 chunk 都 replace/split。
    const scanSse = (text) => {
      frameBuf += text
      if (frameBuf.indexOf("\n\n") < 0 && frameBuf.indexOf("\r\n\r\n") < 0) return
      const parts = frameBuf.replace(/\r\n/g, "\n").split("\n\n")
      frameBuf = parts.pop() // 末段可能不完整，留到下一块
      for (const ev of parts) {
        const data = ev
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (data === "" || data === "[DONE]") continue
        try {
          const obj = JSON.parse(data)
          takeUsage(obj)
          const err = obj && obj.error
          if (err && typeof err === "object" && (err.code || err.message)) streamError = err
        } catch {
          /* 非 JSON 帧，忽略 */
        }
      }
    }

    const tap = new Transform({
      transform(chunk, _enc, callback) {
        try {
          const text = chunk.toString("utf8")
          if (isStream) {
            scanSse(text)
          } else {
            tail += text
            if (tail.length > 262144) tail = tail.slice(-131072)
            grabUsage()
          }
        } catch {
          /* 扫描失败绝不影响转发 */
        }
        callback(null, chunk)
      },
      flush(callback) {
        // 末帧可能没有以空行收尾，补处理一次。
        if (isStream && frameBuf.trim() !== "") {
          try {
            scanSse("\n\n")
          } catch {
            /* ignore */
          }
        }
        const inTok = usage?.input_tokens ?? usage?.prompt_tokens ?? null
        const outTok = usage?.output_tokens ?? usage?.completion_tokens ?? null
        // 仅「流式 2xx 但帧内报 error」才改判失败；非流式沿用 HTTP 状态（上游本就会给正确码）。
        let finalStatus = status
        if (isStream && streamError && status >= 200 && status < 300) {
          const es = Number(streamError.status)
          finalStatus = Number.isFinite(es) && es >= 400 ? es : 502
        }
        log({
          ts: new Date().toISOString(),
          caller: ctx.callerId ?? null,
          name: ctx.callerName ?? null,
          group: ctx.callerGroup ?? null,
          model: ctx.model ?? null,
          path: ctx.path ?? null,
          status: finalStatus,
          error_code: streamError ? (streamError.code ?? null) : null,
          stream: Boolean(ctx.stream),
          ms: Date.now() - startedAt,
          in_tokens: inTok,
          out_tokens: outTok,
          total_tokens: usage?.total_tokens ?? (inTok != null && outTok != null ? inTok + outTok : null),
        })
        callback()
      },
    })

    // 关键：Transform 必须与源流接上，否则下游永远收不到字节（第一版漏了这行，
    // 表现为响应头到了、body 一个字节不来，客户端等到超时）。
    source.pipe(tap)
    return tap
  }

  return { log, tapStream }
}

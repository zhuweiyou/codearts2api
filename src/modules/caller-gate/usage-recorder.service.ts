import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Transform } from "node:stream"

import { utc8Day } from "../../core/day.ts"

function cachedInputTokens(usage: any, input: unknown): number | null {
  if (usage?.cache_read_reported === false || typeof input !== "number" || !Number.isSafeInteger(input)) return null
  const cached =
    usage?.input_tokens_details?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.prompt_cache_hit_tokens
  return Number.isSafeInteger(cached) && cached >= 0 && cached <= input ? cached : null
}

/** 用量记录：把一次调用的结果异步写入 caller-usage/<UTC+8 日期>.jsonl，并在响应流上边转发边采集 usage。 */
export function createUsageRecorder({
  logDir,
  logger,
}: {
  logDir: string
  logger?: any
}) {
  // 异步写 + 串行队列：不阻塞事件循环，同时保证同一进程内写入有序、不交叉。
  // 返回 Promise，便于测试/调用方在需要时 await（服务热路径不 await）。
  let logChain = Promise.resolve()
  function log(entry) {
    const line = `${JSON.stringify(entry)}\n`
    logChain = logChain.then(async () => {
      try {
        await mkdir(logDir, { recursive: true })
        // 按 UTC+8 的「今天」分文件，与总览 / 调用方页的读取口径一致。
        // ⚠️ 不能用服务器本地时区：Docker 镜像默认 UTC，北京时间 00:00-08:00
        //    会写到前一天的文件，而总览按 UTC+8 查今天 → 「今日用量」恒为 0，
        //    同一天的 token-ledger（上游按 UTC+8 记）却有数据。
        await appendFile(join(logDir, `${utc8Day()}.jsonl`), line, "utf8")
      } catch (error) {
        logger?.warn?.(`[caller-gate] 写用量日志失败：${String(error)}`)
      }
    })
    return logChain
  }

  /**
   * 响应流侧回调：边透传边解析用量，结束时写一条日志。不改变字节流本身。
   */
  function tapStream(source, ctx) {
    // ⚠️ 采集**不跟着调用方闸门的开关走**：没有 caller-keys.json 时闸门不鉴权，
    //    但请求照样经过本服务的 /v1 反代，必须记进 caller-usage —— 否则总览
    //    「今日用量」恒为 0（只用网关 key、不配调用方 key 时就是这种形态）。
    //    鉴权决定「能不能调」，记账决定「调了多少」，是两件事。
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
          const isResponsesEnd = obj?.type === "response.completed" || obj?.type === "response.incomplete"
          takeUsage(isResponsesEnd ? obj.response : obj)
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
          cached_tokens: cachedInputTokens(usage, inTok),
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

/**
 * 把 cordis 的日志接到 stdout/stderr。
 *
 * ## 为什么必须显式装 exporter
 *
 * cordis 的 `LoggerService` 构造时**默认只挂了一个内存 exporter**（存最近
 * 1000 条到 `buffer`），**不会**打印到终端。若不装自己的 exporter，插件所有
 * 日志（包括 `[openai-gateway] 已监听 …` 与各 provider 的告警）都会石沉大海
 * —— 用户看到的是「启动了但什么都不输出」，排查时毫无抓手。
 *
 * ## level 的语义（照抄 cordis，别凭直觉）
 *
 * `Logger` 给每个方法固定了数值：`error=0` / `info=1` / `warn=2` / `debug=3`，
 * 而过滤条件是 `(exporter.levels.default ?? 1) < level ⇒ 跳过`。注意
 * **cordis 的默认阈值是 1**，也就是默认只放 error 与 info、**把 warn 挡掉**
 * —— 这与多数人直觉相反，所以这里显式给阈值，不依赖它的默认值。
 */

/** 日志级别名 → exporter 阈值（值越大放行越多）。 */
const THRESHOLDS = {
  silent: -1,
  error: 0,
  // 2 = 放行 error(0) / info(1) / warn(2)；cordis 的默认 1 会吞掉 warn。
  info: 2,
  debug: 3,
}

/**
 * 解析目标阈值。
 *
 * @param env - 进程环境变量。
 * @returns 阈值；非法值回退到 `info`（不因一个拼错的变量而静默丢日志）。
 */
export function resolveLogLevel(env = process.env) {
  const raw = env.LOG_LEVEL?.trim().toLowerCase()
  if (raw === undefined || raw === "") return THRESHOLDS.info
  return THRESHOLDS[raw] ?? THRESHOLDS.info
}

/** 时间戳：`HH:MM:SS.mmm`，本地时区，够看又不啰嗦。 */
function stamp() {
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, "0")
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
}

/**
 * 装一个 stdout/stderr exporter。
 *
 * `warn` 与 `error` 走 stderr（容器里便于单独收集），其余走 stdout。
 *
 * @returns disposer。
 */
export function installLogger(ctx, env = process.env) {
  const threshold = resolveLogLevel(env)
  return ctx.logger.exporter({
    levels: { default: threshold },
    colors: 0,
    export(message) {
      const { type, name, args } = message
      const text = args
        .map((arg) => {
          if (arg instanceof Error) return arg.stack ?? arg.message
          if (typeof arg === "string") return arg
          try {
            return JSON.stringify(arg)
          } catch {
            return String(arg)
          }
        })
        .join(" ")
      const line = `${stamp()} ${type.toUpperCase().padEnd(5)} [${name}] ${text}`
      if (type === "error" || type === "warn") console.error(line)
      else console.log(line)
    },
  })
}

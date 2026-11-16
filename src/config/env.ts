/**
 * 环境变量解析（进程启动配置）。
 *
 * 原则：非法值**显式失败**，不静默换值 —— 静默改端口/开关会让按文档配置的反代指向空。
 */

/** 默认管理端口。 */
export const DEFAULT_PORT = 8080

/** 解析端口（1–65535 整数，否则抛错）。 */
export function resolvePort(env = process.env): number {
  const raw = env.PORT
  if (raw === undefined || raw === "") return DEFAULT_PORT
  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw.trim()) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数，收到：${raw}`)
  }
  return port
}

/** 监听地址：默认全网卡（容器里必须如此，否则宿主访问不到）。 */
export function resolveHost(env = process.env): string {
  const raw = env.HOST?.trim()
  return raw === undefined || raw === "" ? "0.0.0.0" : raw
}

/**
 * 是否把 `/v1/*` 反代到插件网关（默认开启；`PROXY_GATEWAY=0/false/off/no` 关闭）。
 * 默认开启：否则容器里忘设就表现为「服务起来了但 /v1 全 404」，极难排查。
 */
export function resolveProxyGateway(env = process.env): boolean {
  const raw = env.PROXY_GATEWAY?.trim().toLowerCase()
  if (raw === undefined || raw === "") return true
  return !["0", "false", "off", "no"].includes(raw)
}

/**
 * 是否启用管理端鉴权（默认开启；`CODEARTS2API_ADMIN_AUTH=0/false/off/no` 关闭）。
 * 关闭仅用于本机调试。
 */
export function resolveAdminAuth(env = process.env): boolean {
  const raw = env.CODEARTS2API_ADMIN_AUTH?.trim().toLowerCase()
  if (raw === undefined || raw === "") return true
  return !["0", "false", "off", "no"].includes(raw)
}

/**
 * 供应商「可用模型」领域服务。
 *
 * 上游只有两个原始事实源（model.list 目录 / account.list 的 modelRateLimits），
 * “模型能不能用”必须按账号聚合 —— 这是本模块唯一的业务判断。
 */
export class ModelsError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** 目录 + 账号限流 → 逐模型状态。 */
function summarize(models: any[], accounts: any[], now: number) {
  const list = Array.isArray(accounts) ? accounts : []
  const enabled = list.filter((a) => a.enabled !== false)
  return (Array.isArray(models) ? models : []).map((m) => {
    const id = String(m.id)
    const limits: { accountId: string; resetAt: number }[] = []
    for (const acc of enabled) {
      const raw = acc.modelRateLimits
      if (raw === null || typeof raw !== "object") continue
      const at = raw[id]
      if (typeof at === "number" && Number.isFinite(at) && at > now)
        limits.push({ accountId: String(acc.id), resetAt: at })
    }
    const limitedAccounts = limits.length
    const usableAccounts = Math.max(0, enabled.length - limitedAccounts)
    const nextResetAt = limits.length > 0 ? Math.min(...limits.map((l) => l.resetAt)) : null
    let state: string
    if (m.dead === true) state = "dead"
    else if (m.disabled === true) state = "off"
    else if (enabled.length === 0) state = "ok"
    else if (usableAccounts > 0) state = limitedAccounts > 0 ? "partial" : "ok"
    else state = "limited"
    return {
      id,
      name: String(m.name ?? m.id),
      disabled: m.disabled === true,
      dead: m.dead === true,
      isFree: m.isFree === true || m.free === true,
      state,
      limitedAccounts,
      usableAccounts,
      enabledAccounts: enabled.length,
      nextResetAt,
    }
  })
}

function summarizeCounts(rows: any[]) {
  const counts: any = { total: rows.length, ok: 0, partial: 0, limited: 0, off: 0, dead: 0, usable: 0 }
  for (const r of rows) if (counts[r.state] !== undefined) counts[r.state] += 1
  counts.usable = counts.ok + counts.partial
  return counts
}

export function createModelsService(options: any = {}) {
  const rpc = options.rpc
  const logger = options.logger ?? console
  if (typeof rpc !== "function") throw new Error("models service 需要 rpc 依赖")

  async function list(provider: string) {
    if (!provider) throw new ModelsError(400, "provider 必填")
    const value = await rpc("model.list", { provider })
    return { provider, models: Array.isArray(value?.models) ? value.models : [] }
  }

  async function overview(provider: string) {
    if (!provider) throw new ModelsError(400, "provider 必填")
    const value = await rpc("model.list", { provider })
    const models = Array.isArray(value?.models) ? value.models : []
    const now = Date.now()
    const [accountsRes, statusRes] = await Promise.all([
      rpc("account.list", { provider }).catch(() => null),
      rpc("provider.status", { providers: [provider] }).catch(() => null),
    ])
    const accounts = Array.isArray(accountsRes?.accounts) ? accountsRes.accounts : []
    const rows = summarize(models, accounts, now)
    return {
      provider,
      now,
      models: rows,
      counts: summarizeCounts(rows),
      accounts: accounts.map((a: any) => ({
        id: String(a.id),
        nickname: String(a.nickname ?? a.id),
        enabled: a.enabled !== false,
      })),
      accountsError: accountsRes === null ? "账号列表读取失败（限流状态不可用）" : null,
      providerStatus: statusRes?.statuses?.[provider] ?? null,
    }
  }

  async function status(providers: string[]) {
    const value = await rpc("provider.status", { providers })
    return { statuses: value?.statuses ?? {} }
  }

  async function toggle({ provider, modelId, disabled }: any) {
    if (!provider || !modelId) throw new ModelsError(400, "provider 与 modelId 必填")
    if (typeof disabled !== "boolean") throw new ModelsError(400, "disabled 必须是布尔值（上游不做默认值猜测）")
    const value = await rpc("model.setDisabled", { provider, modelId, disabled })
    logger?.info?.(`[models] ${disabled ? "关闭" : "打开"} ${provider}/${modelId}`)
    return { ok: true, warnings: value?.warnings ?? [] }
  }

  async function toggleMany({ provider, modelIds, disabled }: any) {
    if (!provider || !Array.isArray(modelIds) || modelIds.length === 0)
      throw new ModelsError(400, "provider 与 modelIds（非空数组）必填")
    if (typeof disabled !== "boolean") throw new ModelsError(400, "disabled 必须是布尔值")
    const value = await rpc("model.setDisabledMany", { provider, modelIds, disabled })
    logger?.info?.(`[models] ${provider} 批量${disabled ? "关闭" : "打开"} ${modelIds.length} 个`)
    return { ok: true, warnings: value?.warnings ?? [] }
  }

  return { list, overview, status, toggle, toggleMany }
}

export type ModelsService = ReturnType<typeof createModelsService>

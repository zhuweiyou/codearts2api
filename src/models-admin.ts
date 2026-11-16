/**
 * 供应商「可用模型」清单 —— 后端代理 + 右侧面板 UI 挂载。
 *
 * 用户需求演进（2026-11-02）：
 *   第一版理解错了：把模型清单挂在左侧供应商行下面（chip 展开）。
 *   用户纠正（原文）：「我让你做的不是在供应商下面显示模型列表，而是在右侧显示
 *   当前账号下面的可用模型列表。因为有的模型会限流有的模型可以正常使用。」
 *
 * 所以本版：
 *   - **删掉左侧 chip / 展开清单**，DOM 里不再注入任何 rail 内容。
 *   - 在**右侧** `main.dim-jh-panel` 顶部插一块「<供应商> 可用模型」区域，
 *     逐模型给出真实可用状态：可用 / 部分限流 / 全部限流 / 已关闭 / 已下架。
 *   - 仍保留每个模型的启用开关（关闭后 `/v1/models` 不再列出，符合前一条需求）。
 *
 * ## 状态是怎么算出来的（这是本模块唯一有判断的地方）
 *
 * 上游**没有**「模型级可用性」接口，只有两个原始事实源：
 *   1. `model.list`  → 目录（全量，含 `disabled` 黑名单标记 / `dead` 失效标记）
 *   2. `account.list` → 每个账号的 `modelRateLimits`：`{modelId: 重置时间戳(ms)}`
 *
 * 限流是**账号粒度**的（同一个模型，A 号被限流、B 号还能用），所以「模型能不能用」
 * 必须按账号聚合，判据是「是否还存在至少一个**已启用且未被限流**的账号」：
 *   - dead                      → 已下架（上游没有这个模型了）
 *   - disabled                  → 已关闭（被黑名单关掉，下游拉不到）
 *   - 无任何已启用账号           → 可用（聚合/匿名渠道无从判断，不臆断为不可用）
 *   - 部分账号被限流、仍有人可用  → 部分限流（能调，但选号可能失败）
 *   - 全部已启用账号都被限流      → 全部限流（等同不可用，直到重置时间）
 *
 * 这条口径直接回答用户这句：「有的模型会限流有的模型可以正常使用」。
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }

export const API_PATH = "/admin/models/api"

function sendJson(response, status, body) {
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(body))
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

/**
 * 只放行这五个动作。`overview` 是本模块自己的聚合读，其余四个是上游原样代理。
 */
const ACTIONS = new Set(["overview", "list", "toggle", "toggleMany", "status"])

/**
 * 把「目录 + 账号限流」合成为逐模型状态。
 *
 * @param {Array} models   `model.list` 的 models（含 id/name/disabled/dead）
 * @param {Array} accounts `account.list` 的 accounts（含 enabled/modelRateLimits）
 * @param {number} now     统一时间基准（避免逐条 Date.now() 出现跨秒不一致）
 */
function summarize(models, accounts, now) {
  const list = Array.isArray(accounts) ? accounts : []
  const enabled = list.filter((a) => a.enabled !== false)
  const rows = (Array.isArray(models) ? models : []).map((m) => {
    const id = String(m.id)
    const limits = []
    for (const acc of enabled) {
      const raw = acc.modelRateLimits
      if (raw === null || typeof raw !== "object") continue
      const at = raw[id]
      if (typeof at === "number" && Number.isFinite(at) && at > now) {
        limits.push({ accountId: String(acc.id), resetAt: at })
      }
    }
    const limitedAccounts = limits.length
    const usableAccounts = Math.max(0, enabled.length - limitedAccounts)
    const nextResetAt = limits.length > 0 ? Math.min(...limits.map((l) => l.resetAt)) : null

    let state
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
  return rows
}

function summarizeCounts(rows) {
  const counts = { total: rows.length, ok: 0, partial: 0, limited: 0, off: 0, dead: 0 }
  for (const r of rows) {
    if (counts[r.state] !== undefined) counts[r.state] += 1
  }
  counts.usable = counts.ok + counts.partial
  return counts
}

/**
 * @param {{rpc: (method: string, payload?: object) => Promise<any>, logger?: object}} options
 */
export function createModelsAdmin(options) {
  const rpc = options.rpc
  if (typeof rpc !== "function") throw new Error("models-admin 需要 rpc 依赖")

  async function handleApi(request, response) {
    let payload
    try {
      payload = await readBody(request)
    } catch (error) {
      sendJson(response, 400, { error: "请求体不是合法 JSON：" + String(error) })
      return
    }
    const action = String(payload?.action ?? "")
    if (!ACTIONS.has(action)) {
      sendJson(response, 400, { error: `未知操作 ${action || "（空）"}` })
      return
    }

    try {
      if (action === "overview" || action === "list") {
        const provider = String(payload.provider ?? "")
        if (provider.length === 0) {
          sendJson(response, 400, { error: "provider 必填" })
          return
        }

        const value = await rpc("model.list", { provider })
        const models = Array.isArray(value?.models) ? value.models : []

        // 纯 `list` 只回目录，不碰账号（保持与旧版一致，便于排查）。
        if (action === "list") {
          sendJson(response, 200, { provider, models })
          return
        }

        const now = Date.now()
        // 账号与供应商状态都是「辅助信息」：读失败不能让整块面板挂掉，
        // 否则一次 500 会把用户已经能看到的模型目录一起吞掉。
        const [accountsRes, statusRes] = await Promise.all([
          rpc("account.list", { provider }).catch(() => null),
          rpc("provider.status", { providers: [provider] }).catch(() => null),
        ])
        const accounts = Array.isArray(accountsRes?.accounts) ? accountsRes.accounts : []
        const rows = summarize(models, accounts, now)

        sendJson(response, 200, {
          provider,
          now,
          models: rows,
          counts: summarizeCounts(rows),
          accounts: accounts.map((a) => ({
            id: String(a.id),
            nickname: String(a.nickname ?? a.id),
            enabled: a.enabled !== false,
          })),
          accountsError: accountsRes === null ? "账号列表读取失败（限流状态不可用）" : null,
          providerStatus: statusRes?.statuses?.[provider] ?? null,
        })
        return
      }

      if (action === "status") {
        const providers = Array.isArray(payload.providers)
          ? payload.providers.map((p) => String(p)).filter((p) => p.length > 0)
          : []
        if (providers.length === 0) {
          sendJson(response, 400, { error: "providers 必须是非空字符串数组" })
          return
        }
        const value = await rpc("provider.status", { providers })
        sendJson(response, 200, { statuses: value?.statuses ?? {} })
        return
      }

      if (action === "toggle") {
        const provider = String(payload.provider ?? "")
        const modelId = String(payload.modelId ?? "")
        if (provider.length === 0 || modelId.length === 0) {
          sendJson(response, 400, { error: "provider 与 modelId 必填" })
          return
        }
        if (typeof payload.disabled !== "boolean") {
          sendJson(response, 400, { error: "disabled 必须是布尔值（上游不做默认值猜测）" })
          return
        }
        const value = await rpc("model.setDisabled", {
          provider,
          modelId,
          disabled: payload.disabled,
        })
        options.logger?.info?.(`[models] ${payload.disabled ? "关闭" : "打开"} ${provider}/${modelId}`)
        sendJson(response, 200, { ok: true, warnings: value?.warnings ?? [] })
        return
      }

      // toggleMany：清单里的「全部关闭 / 全部打开」
      const provider = String(payload.provider ?? "")
      const modelIds = Array.isArray(payload.modelIds)
        ? payload.modelIds.map((m) => String(m)).filter((m) => m.length > 0)
        : []
      if (provider.length === 0 || modelIds.length === 0) {
        sendJson(response, 400, { error: "provider 与 modelIds（非空数组）必填" })
        return
      }
      if (typeof payload.disabled !== "boolean") {
        sendJson(response, 400, { error: "disabled 必须是布尔值" })
        return
      }
      const value = await rpc("model.setDisabledMany", {
        provider,
        modelIds,
        disabled: payload.disabled,
      })
      options.logger?.info?.(`[models] ${provider} 批量${payload.disabled ? "关闭" : "打开"} ${modelIds.length} 个`)
      sendJson(response, 200, { ok: true, warnings: value?.warnings ?? [] })
    } catch (error) {
      options.logger?.error?.(`[models] ${action} 失败：${String(error)}`)
      sendJson(response, 500, { error: String(error && error.message ? error.message : error) })
    }
  }

  return {
    async handle(request, response, url) {
      if (url.pathname === API_PATH) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "只支持 POST" })
          return true
        }
        await handleApi(request, response)
        return true
      }

      return false
    },
  }
}

/**
 * UI 脚本。注入点选择（**右侧**）：
 *
 *   `main.dim-jh-panel` 是右侧面板容器（`上游客户端 bundle（dist/assets/jet-hub-*.js）`
 *   的 `div.dim-jh-layout > main.dim-jh-panel`）。它内部按当前选中供应商渲染
 *   `ProviderPanel`（内含 `.dim-jh-accountSection`「XX 账号管理」+ 账号卡片）。
 *
 *   把本模块的 `section.c2x-section` 作为 `main.dim-jh-panel` 的**第一个子节点**，
 *   就落在「XX 账号管理」上方 —— 先看模型能不能用，再看号。
 *
 * 当前选中的供应商不靠 JS 状态推断，而是直接读原生 DOM：
 *   `.dim-jh-providerRow[data-provider]` 里的 `button.dim-jh-provider[aria-selected=true]`
 *   —— 这是 `renderProviderRow`（`upstream-jet-hub.js:12846`）写的真实属性，
 *   比在脚本里自己记一份 selected 更可靠（用户点左栏、React 重渲染都一致）。
 *
 * React 每次重渲染都会把注入节点冲掉，所以必须用常驻 MutationObserver 重新挂载，
 * 且把「筛选词 / 状态筛选」记在自己的 map 里（不能依赖 DOM）。
 */

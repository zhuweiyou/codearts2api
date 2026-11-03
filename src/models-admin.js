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
export const UI_PATH = "/admin/models-ui.js"

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

      if (url.pathname === UI_PATH) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" })
          response.end("Method Not Allowed")
          return true
        }
        const body = Buffer.from(UI_SRC, "utf8")
        response.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "content-length": String(body.length),
          "cache-control": "no-store",
        })
        response.end(request.method === "HEAD" ? undefined : body)
        return true
      }

      return false
    },
  }
}

/**
 * UI 脚本。注入点选择（**右侧**）：
 *
 *   `main.dim-jh-panel` 是右侧面板容器（`public/upstream-jet-hub.js:13052`
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
export const UI_SRC = String.raw`
(function () {
  "use strict";
  if (window.__c2xModelsUI) return;
  window.__c2xModelsUI = true;

  var API = "/admin/models/api";
  var STYLE_ID = "c2x-style";
  var SECTION_ATTR = "data-c2x-section";

  var cache = Object.create(null);   // provider -> overview 响应
  var loadingFor = null;             // 正在拉取的 provider（单飞）
  var busyModel = Object.create(null); // provider + "\u0000" + modelId -> true
  var view = Object.create(null);    // provider -> {q:'', filter:'all'}（默认全量，见 filterOf 注释）
  var open = true;                   // 整块是否展开（用户可折叠）
  var pollTimer = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  /* 限额重置时间的显示口径与原生一致（formatTime 的 HH:MM，跨天带日期）。 */
  function fmtReset(ts) {
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
    var d = new Date(ts);
    var now = new Date();
    var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = [
      /* 整块容器：与右侧面板内其它 section 同宽，白底卡片风 */
      ".c2x-section{flex:none;margin-bottom:16px;border:1px solid var(--dsw-alias-border-l2,#eef0f3);border-radius:14px;background:var(--dsw-alias-bg-layer-3,#fff);overflow:hidden;box-shadow:0 2px 8px rgb(31 35 41/3%)}",
      ".c2x-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#eef0f3);background:var(--dsw-alias-bg-layer-2,#f4f5f7)}",
      ".c2x-title{margin:0;font-size:13px;line-height:19px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".c2x-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8f959e);font-variant-numeric:tabular-nums}",
      ".c2x-tools{display:flex;align-items:center;gap:6px;margin-left:auto}",
      ".c2x-tools input{width:130px;border:1px solid var(--dsw-alias-border-default,#e5e5e5);border-radius:8px;padding:3px 8px;font:inherit;font-size:11.5px;color:var(--dsw-alias-label-primary,#1f2329);background:#fff}",
      ".c2x-tools input::placeholder{color:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2x-tab{appearance:none;border:1px solid var(--dsw-alias-border-default,#e5e5e5);border-radius:999px;background:#fff;padding:2px 9px;font:inherit;font-size:11px;line-height:16px;cursor:pointer;color:var(--dsw-alias-text-secondary,#4e5969);white-space:nowrap}",
      ".c2x-tab:hover{border-color:var(--dsw-alias-brand-primary,#1677ff);color:var(--dsw-alias-brand-primary,#1677ff)}",
      ".c2x-tab[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary,#1677ff);background:color-mix(in srgb,#1677ff 10%,#fff);color:var(--dsw-alias-brand-primary,#1677ff);font-weight:500}",
      ".c2x-tab .t{font-variant-numeric:tabular-nums}",
      ".c2x-icon{appearance:none;width:24px;height:24px;display:grid;place-items:center;border:1px solid var(--dsw-alias-border-default,#e5e5e5);border-radius:8px;background:#fff;cursor:pointer;color:var(--dsw-alias-text-secondary,#4e5969);font-size:12px;line-height:1}",
      ".c2x-icon:hover{border-color:var(--dsw-alias-brand-primary,#1677ff);color:var(--dsw-alias-brand-primary,#1677ff)}",
      /* 汇总条：一眼看到「可用几个 / 限流几个 / 关了几个」 */
      ".c2x-sum{display:flex;flex-wrap:wrap;gap:14px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#eef0f3);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#5f6672)}",
      ".c2x-sum b{font-variant-numeric:tabular-nums;font-weight:600}",
      ".c2x-sum .ok b{color:var(--dsw-alias-state-success-primary,#15803d)}",
      ".c2x-sum .warn b{color:var(--dsw-alias-state-warn-primary,#b45309)}",
      ".c2x-sum .bad b{color:var(--dsw-alias-state-error-primary,#d93025)}",
      ".c2x-sum .mute b{color:var(--dsw-alias-label-tertiary,#8f959e)}",
      /* 逐模型行：复用原生 .dim-jh-modelRow-ish 的排布，但独立命名避免抢样式 */
      ".c2x-scroll{max-height:330px;overflow:auto}",
      ".c2x-mrow{display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#f4f5f7);min-width:0}",
      ".c2x-mrow:last-child{border-bottom:0}",
      ".c2x-mrow:hover{background:var(--dsw-alias-bg-layer-2,#f7f8fa)}",
      ".c2x-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#15803d)}",
      ".c2x-mrow[data-state=partial] .c2x-dot{background:var(--dsw-alias-state-warn-primary,#b45309)}",
      ".c2x-mrow[data-state=limited] .c2x-dot{background:var(--dsw-alias-state-error-primary,#d93025)}",
      ".c2x-mrow[data-state=off] .c2x-dot,.c2x-mrow[data-state=dead] .c2x-dot{background:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2x-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".c2x-id{flex:0 1 auto;min-width:0;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,#f4f5f7);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2x-mrow[data-state=off] .c2x-name,.c2x-mrow[data-state=dead] .c2x-name{color:var(--dsw-alias-label-tertiary,#8f959e);text-decoration:line-through}",
      ".c2x-tag{flex:none;display:inline-block;padding:0 7px;border-radius:999px;font-size:10.5px;line-height:16px;white-space:nowrap}",
      ".c2x-tag.ok{background:rgb(21 128 61/10%);color:var(--dsw-alias-state-success-primary,#15803d)}",
      ".c2x-tag.partial{background:rgb(180 83 9/10%);color:var(--dsw-alias-state-warn-primary,#b45309)}",
      ".c2x-tag.limited{background:rgb(217 48 37/10%);color:var(--dsw-alias-state-error-primary,#d93025)}",
      ".c2x-tag.off{background:rgb(143 149 158/14%);color:var(--dsw-alias-label-secondary,#5f6672)}",
      ".c2x-tag.dead{background:rgb(180 83 9/10%);color:var(--dsw-alias-state-warn-primary,#b45309)}",
      ".c2x-reset{flex:none;font-size:10.5px;line-height:16px;color:var(--dsw-alias-state-warn-primary,#b45309);font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".c2x-acc{flex:none;margin-left:auto;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8f959e);font-variant-numeric:tabular-nums;white-space:nowrap}",
      /* 开关：26x14 胶囊，比原生的细一点，避免抢视觉焦点 */
      ".c2x-sw{flex:none;position:relative;width:28px;height:15px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-default,#d0d3d9);cursor:pointer;transition:background .15s}",
      ".c2x-sw::after{content:'';position:absolute;top:1.5px;left:1.5px;width:12px;height:12px;border-radius:50%;background:#fff;transition:left .15s}",
      ".c2x-sw[aria-checked=true]{background:var(--dsw-alias-brand-primary,#1677ff)}",
      ".c2x-sw[aria-checked=true]::after{left:14.5px}",
      ".c2x-sw:disabled{opacity:.5;cursor:default}",
      ".c2x-empty{padding:16px 12px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8f959e);text-align:center}",
      ".c2x-err{padding:8px 12px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-state-error-primary,#d93025);background:#fdf3f2;border-top:1px solid #f5c2c0}",
      ".c2x-note{padding:6px 12px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8f959e);border-top:1px solid var(--dsw-alias-border-l2,#eef0f3)}"
    ].join("\n");
    document.head.appendChild(st);
  }

  function post(body) {
    return fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin"
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.error) || ("HTTP " + r.status));
        return data;
      });
    });
  }

  /* ---------- 当前选中的供应商 ---------- */

  function currentProvider() {
    var btn = document.querySelector('.dim-jh-providerRow[data-provider] button.dim-jh-provider[aria-selected="true"]');
    if (btn === null) return null;
    var row = btn.closest(".dim-jh-providerRow[data-provider]");
    if (row === null) return null;
    var id = row.getAttribute("data-provider");
    if (!id) return null;
    var label = btn.querySelector(".dim-jh-providerLabel strong");
    return { id: id, label: label ? label.textContent : id };
  }

  /* ---------- 渲染 ---------- */

  function stateText(m) {
    if (m.state === "dead") return "已下架";
    if (m.state === "off") return "已关闭";
    if (m.state === "limited") return "全部限流";
    if (m.state === "partial") return "部分限流";
    return "可用";
  }

  /* 默认视图必须是「全部」：设成「可用」会把正在限流的模型直接筛掉，
     用户展开后只看到一片绿，会以为「全部可用」——正是 2026-11-02 用户报的
     「qodercn 7 个模型限流，但是下拉箭头展开以后全部显示可用」。
     默认全量 + 行内限流徽章，才看得见问题。 */
  function filterOf(provider) {
    if (view[provider] === undefined) view[provider] = { q: "", filter: "all" };
    return view[provider];
  }

  function visibleModels(provider, data) {
    var v = filterOf(provider);
    var q = v.q.trim().toLowerCase();
    var all = data.models || [];
    return all.filter(function (m) {
      if (q.length > 0) {
        var hay = (m.id + " " + (m.name || "")).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      if (v.filter === "usable") return m.state === "ok" || m.state === "partial";
      if (v.filter === "limited") return m.state === "limited" || m.state === "partial";
      if (v.filter === "off") return m.state === "off" || m.state === "dead";
      return true;
    });
  }

  function renderRows(provider, data) {
    var rows = visibleModels(provider, data);
    if (rows.length === 0) {
      return '<div class="c2x-empty">没有匹配的模型</div>';
    }
    var busySet = busyModel;
    return rows.map(function (m) {
      var key = provider + "\u0000" + m.id;
      var isBusy = busySet[key] === true;
      var reset = m.nextResetAt !== null && m.nextResetAt !== undefined ? fmtReset(m.nextResetAt) : "";
      var accText = m.enabledAccounts > 0
        ? (m.usableAccounts + "/" + m.enabledAccounts + " 号可用")
        : "无账号";
      return '<div class="c2x-mrow" data-state="' + m.state + '" data-model="' + esc(m.id) + '">'
        + '<span class="c2x-dot"></span>'
        + '<span class="c2x-name" title="' + esc(m.name || m.id) + '">' + esc(m.name || m.id) + "</span>"
        + '<code class="c2x-id" title="' + esc(m.id) + '">' + esc(m.id) + "</code>"
        + '<span class="c2x-tag ' + m.state + '">' + stateText(m) + "</span>"
        + (reset ? '<span class="c2x-reset" title="限额重置时间">' + esc(reset) + "</span>" : "")
        + '<span class="c2x-acc" title="已启用账号中还能用该模型的比例">' + esc(accText) + "</span>"
        + '<button type="button" class="c2x-sw" role="switch" aria-checked="' + (m.disabled ? "false" : "true") + '"'
        + (isBusy ? " disabled" : "")
        + ' data-c2x-toggle="' + esc(m.id) + '" aria-label="' + esc((m.name || m.id) + " 是否启用") + '"></button>'
        + "</div>";
    }).join("");
  }

  function renderSection(provider, data) {
    var v = filterOf(provider);
    var c = data.counts || { total: 0, usable: 0, partial: 0, limited: 0, off: 0, dead: 0 };
    var headline = esc(provider.label) + " 可用模型";
    var sub = c.usable + "/" + c.total + " 个可用";

    var tabs = [
      { id: "usable", label: "可用", n: c.usable },
      { id: "limited", label: "限流", n: c.limited + c.partial },
      { id: "off", label: "已关闭", n: c.off + c.dead },
      { id: "all", label: "全部", n: c.total }
    ].map(function (t) {
      return '<button type="button" class="c2x-tab" data-c2x-filter="' + t.id + '" aria-pressed="' + (v.filter === t.id ? "true" : "false") + '">'
        + t.label + ' <span class="t">' + t.n + "</span></button>";
    }).join("");

    var sum = '<div class="c2x-sum">'
      + '<span class="ok">可用 <b>' + c.usable + "</b></span>"
      + '<span class="warn">部分限流 <b>' + c.partial + "</b></span>"
      + '<span class="bad">全部限流 <b>' + c.limited + "</b></span>"
      + '<span class="mute">已关闭 <b>' + c.off + "</b></span>"
      + '<span class="mute">已下架 <b>' + c.dead + "</b></span>"
      + '<span class="mute">共 <b>' + c.total + "</b></span>"
      + "</div>";

    var err = data.accountsError
      ? '<div class="c2x-err">' + esc(data.accountsError) + " —— 限流状态不可信，请刷新重试</div>"
      : "";

    var note = '<div class="c2x-note">「可用」＝ 至少还有一个已启用账号没被该模型限流；「全部限流」＝ 所有已启用账号都在重置窗口内。关闭开关后下游 <code>/v1/models</code> 不再列出该模型。</div>';

    return '<section class="c2x-section" ' + SECTION_ATTR + '="' + esc(provider.id) + '">'
      + '<div class="c2x-head">'
      + "<h3 class=\"c2x-title\">" + headline + "</h3>"
      + '<span class="c2x-sub">' + esc(sub) + "</span>"
      + '<div class="c2x-tools">'
      + '<input type="text" data-c2x-q placeholder="筛选模型…" value="' + esc(v.q) + '">'
      + tabs
      + '<button type="button" class="c2x-icon" data-c2x-refresh title="刷新">&#8635;</button>'
      + '<button type="button" class="c2x-icon" data-c2x-fold title="' + (open ? "折叠" : "展开") + '">' + (open ? "&#9650;" : "&#9660;") + "</button>"
      + "</div></div>"
      + (open ? sum + '<div class="c2x-scroll">' + renderRows(provider, data) + "</div>" + err + note : "")
      + "</section>";
  }

  /* ---------- 挂载（React 会冲掉注入节点，必须反复重挂） ---------- */

  function mount() {
    ensureStyle();
    var main = document.querySelector("main.dim-jh-panel");
    if (main === null) return;

    var provider = currentProvider();
    var existing = main.querySelector("[" + SECTION_ATTR + "]");

    if (provider === null) {
      if (existing !== null) existing.remove();
      return;
    }

    var data = cache[provider.id];
    var html;
    if (data === undefined) {
      html = '<section class="c2x-section" ' + SECTION_ATTR + '="' + esc(provider.id) + '">'
        + '<div class="c2x-head"><h3 class="c2x-title">' + esc(provider.label) + ' 可用模型</h3>'
        + '<span class="c2x-sub">加载中…</span></div></section>';
    } else {
      html = renderSection(provider, data);
    }

    /* 只在内容真的变了才写 DOM。否则 MutationObserver 会被自己的写入再触发，
       形成无限循环（第一版踩过）。 */
    var key = provider.id + "\u0001" + (data === undefined ? "loading" : JSON.stringify(data.counts || {}))
      + "\u0001" + JSON.stringify(filterOf(provider)) + "\u0001" + (open ? "1" : "0")
      + "\u0001" + Object.keys(busyModel).join(",");
    if (existing !== null && existing.getAttribute("data-c2x-key") === key) {
      return;
    }

    if (existing !== null) {
      existing.remove();
    }
    var wrap = document.createElement("div");
    wrap.innerHTML = html;
    var section = wrap.firstElementChild;
    section.setAttribute("data-c2x-key", key);
    main.insertBefore(section, main.firstChild);
  }

  function ensureData(providerId) {
    if (cache[providerId] !== undefined) return;
    if (loadingFor === providerId) return;
    loadingFor = providerId;
    post({ action: "overview", provider: providerId })
      .then(function (data) {
        cache[providerId] = data;
      })
      .catch(function (error) {
        cache[providerId] = { models: [], counts: { total: 0, usable: 0, partial: 0, limited: 0, off: 0, dead: 0 }, accountsError: String(error.message || error) };
      })
      .then(function () {
        loadingFor = null;
        mount();
      });
  }

  function refresh(providerId) {
    delete cache[providerId];
    mount();
    ensureData(providerId);
  }

  /* ---------- 交互：全部走事件委托，避免重建时丢监听 ---------- */

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    var section = target.closest("[" + SECTION_ATTR + "]");
    if (section === null) return;
    var providerId = section.getAttribute(SECTION_ATTR);
    var provider = currentProvider();
    if (provider === null || provider.id !== providerId) return;

    var foldBtn = target.closest("[data-c2x-fold]");
    if (foldBtn !== null) {
      open = !open;
      mount();
      return;
    }

    var refreshBtn = target.closest("[data-c2x-refresh]");
    if (refreshBtn !== null) {
      refresh(providerId);
      return;
    }

    var tab = target.closest("[data-c2x-filter]");
    if (tab !== null) {
      filterOf(providerId).filter = tab.getAttribute("data-c2x-filter");
      mount();
      return;
    }

    var sw = target.closest("[data-c2x-toggle]");
    if (sw !== null) {
      var modelId = sw.getAttribute("data-c2x-toggle");
      var nextDisabled = sw.getAttribute("aria-checked") === "true";
      var busyKey = providerId + "\u0000" + modelId;
      if (busyModel[busyKey] === true) return;
      busyModel[busyKey] = true;
      mount();
      post({ action: "toggle", provider: providerId, modelId: modelId, disabled: nextDisabled })
        .then(function () {
          delete busyModel[busyKey];
          refresh(providerId);
        })
        .catch(function (error) {
          delete busyModel[busyKey];
          var data = cache[providerId];
          if (data !== undefined) data.accountsError = "开关失败：" + String(error.message || error);
          mount();
        });
    }
  }, true);

  /* 搜索框：只重绘滚动区，不重建输入框（否则光标会跳、中文输入法会断） */
  document.addEventListener("input", function (event) {
    var target = event.target;
    if (!target || target.nodeType !== 1) return;
    if (target.getAttribute("data-c2x-q") === null) return;
    var section = target.closest("[" + SECTION_ATTR + "]");
    if (section === null) return;
    var providerId = section.getAttribute(SECTION_ATTR);
    filterOf(providerId).q = target.value;
    var scroll = section.querySelector(".c2x-scroll");
    var data = cache[providerId];
    if (scroll !== null && data !== undefined) {
      scroll.innerHTML = renderRows({ id: providerId, label: "" }, data);
    }
  }, true);

  /* ---------- 主循环：观察重渲染 + 定时刷新 ---------- */

  function tick() {
    var provider = currentProvider();
    if (provider !== null) ensureData(provider.id);
    mount();
  }

  var scheduled = false;
  var observer = new MutationObserver(function () {
    if (scheduled) return;
    scheduled = true;
    /* 必须用 setTimeout 而不是 requestAnimationFrame：rAF 只在页面可见时触发，
       页面一旦被最小化/切到后台就彻底停摆，scheduled 会卡在 true，
       之后切换供应商再也不重挂 —— 2026-11-02 实测「选了 qodercn 面板还显示
       codearts 的模型」。setTimeout 不受 visibilityState 影响。 */
    setTimeout(function () {
      scheduled = false;
      tick();
    }, 0);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  /* 30 秒刷一次（限流是随时间变的，不动就一直是旧数）；页面不可见时跳过。 */
  pollTimer = setInterval(function () {
    if (document.visibilityState !== "visible") return;
    var provider = currentProvider();
    if (provider === null) return;
    delete cache[provider.id];
    ensureData(provider.id);
  }, 30000);

  tick();
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") tick();
  });
})();
`

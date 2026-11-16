import clsx from "clsx"
import { useState } from "react"

import { ago, when } from "../../utils/time"
import { Card } from "./Card"
import { Cards } from "./Cards"
import { ProviderHead } from "./ProviderHead"
import { Section } from "./Section"
import { fmt, fmtAmt, fmtTokens, leftDays } from "./format"
import styles from "./sections.module.less"

/* ── 网关状态 ─────────────────────────────────────────────────── */

export function GatewaySection({ data }: { data: any }) {
  const g = data.gateway || {}
  const gw = g.gateway || {}
  const ok = g.ok === true
  const modelCount = gw.modelCount !== undefined ? gw.modelCount : (data.models || []).length
  const acc = data.accounts || []
  const enabled = acc.filter((a: any) => a.enabled).length
  const port = gw.address && gw.address.port !== undefined ? gw.address.port : "?"
  const callerGroups = data.callers && data.callers.groups !== undefined ? data.callers.groups : 0
  return (
    <Section title="网关状态">
      <Cards>
        <Card k="服务状态" v={ok ? "运行中" : "异常"} f={"监听 127.0.0.1:" + port} tone={ok ? "ok" : "bad"} />
        <Card k="上游渠道" v={(g.providers || []).length} u="个" f="已接通的 provider" />
        <Card k="可用模型" v={fmt(modelCount)} u="个" f="网关下发的模型总数" tone="brand" />
        <Card k="账号池" v={enabled + " / " + acc.length} f="启用 / 总数" />
        <Card k="调用方 key" v={fmt(data.callers && data.callers.keys)} u="把" f={"分组 " + callerGroups + " 个"} />
        <Card k="数据快照" v={ago(data.generatedAt)} f="每 30 秒自动刷新" />
      </Cards>
    </Section>
  )
}

/* ── 今日用量 ─────────────────────────────────────────────────── */

export function UsageSection({ data }: { data: any }) {
  const t = data.usage && data.usage.today
  if (!t) {
    return (
      <Section title="今日用量">
        <div className={styles.empty}>今天还没有请求记录</div>
      </Section>
    )
  }
  const ledger = (data.ledger || []).find((x: any) => x.date === t.date) || {}
  const rate = t.requests > 0 ? (t.ok / t.requests) * 100 : null
  const tone = rate === null ? "" : rate >= 99 ? "ok" : rate >= 95 ? "warn" : "bad"
  const cacheRead = ledger.cacheRead || 0
  const cacheBase = (t.inTokens || 0) + cacheRead
  const cacheRate = cacheBase > 0 ? ((cacheRead / cacheBase) * 100).toFixed(1) : "0.0"
  return (
    <Section title="今日用量">
      <Cards>
        <Card k="今日请求" v={fmt(t.requests)} u="次" f={"成功 " + fmt(t.ok) + " · 失败 " + fmt(t.errors)} />
        <Card k="成功率" v={rate === null ? "—" : rate.toFixed(1)} u="%" f="按今日请求统计" tone={tone} />
        <Card k="输入 tokens" v={fmtTokens(t.inTokens)} f="上下文占大头" tone="brand" />
        <Card k="输出 tokens" v={fmtTokens(t.outTokens)} f="生成部分" />
        <Card k="缓存命中" v={cacheRate} u="%" f={"缓存读 " + fmtTokens(cacheRead)} />
        <Card k="首字延迟" v={ledger.ttftAvgMs ? fmt(ledger.ttftAvgMs) + " ms" : "—"} f="平均 TTFT" />
      </Cards>
    </Section>
  )
}

/* ── 近 14 日趋势 ─────────────────────────────────────────────── */

export function TrendChart({ days, pick, fn }: { days: any[]; pick: (x: any) => number; fn: (n: any) => string }) {
  if (!days || !days.length) {
    return (
      <>
        <div className={styles.trend}>
          <div className={clsx(styles.muted, "c2a-trend-empty")}>暂无数据</div>
        </div>
        <div className={styles.axis} />
      </>
    )
  }
  const vals = days.map(pick)
  const max = Math.max(1, ...vals)
  return (
    <>
      <div className={styles.trend}>
        {days.map((day, i) =>
          day.empty ? (
            <div key={day.date} className={styles.col} title={day.date + "：无数据"}>
              <i className={clsx(styles.nodata, "c2a-trend-nodata")} />
            </div>
          ) : (
            <div key={day.date} className={styles.col} title={day.date + "：" + fn(vals[i])}>
              <i style={{ height: Math.max(2, Math.round((vals[i] / max) * 100)) + "%" }} />
            </div>
          ),
        )}
      </div>
      <div className={styles.axis}>
        {days.map((day) => (
          <span key={day.date} className={clsx(day.empty ? styles.nodata : undefined)}>
            {String(day.date).slice(5)}
          </span>
        ))}
      </div>
    </>
  )
}

export function TrendSection({ data }: { data: any }) {
  const days = (data.usage && data.usage.days) || []
  return (
    <Section title="近 14 日趋势">
      <div className={styles.two}>
        <div>
          <TrendChart days={days} pick={(x) => x.requests} fn={fmt} />
          <div className={clsx(styles.muted, "c2a-trend-label")}>每日请求数</div>
        </div>
        <div>
          <TrendChart days={days} pick={(x) => (x.inTokens || 0) + (x.outTokens || 0)} fn={fmtTokens} />
          <div className={clsx(styles.muted, "c2a-trend-label")}>每日 Token 总量</div>
        </div>
      </div>
    </Section>
  )
}

/* ── 渠道账号与余额 ───────────────────────────────────────────── */

export function AccountsSection({ data }: { data: any }) {
  const accounts = data.accounts || []
  if (!accounts.length) {
    return (
      <Section title="渠道账号与余额">
        <div className={styles.empty}>账号池为空</div>
      </Section>
    )
  }
  const byAcc: Record<string, any> = {}
  Object.keys(data.balances || {}).forEach((p) => {
    const pack = data.balances[p]
    ;((pack && pack.accounts) || []).forEach((row: any) => {
      byAcc[row.accountId] = { ...row, provider: p }
    })
  })
  const cached = data.balancesCachedAt ? " · " + ago(new Date(data.balancesCachedAt).toISOString()) : ""
  return (
    <Section title="渠道账号与余额">
      <div className={styles.tblWrap}>
        <table className={styles.tbl}>
          <thead>
            <tr>
              <th>渠道</th>
              <th>账号</th>
              <th>状态</th>
              <th>凭据有效期</th>
              <th>限流</th>
              <th className={styles.num}>余额合计</th>
              <th>积分包（缓存 5 分钟{cached}）</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a: any) => {
              const bal = byAcc[a.id]
              const pkgs = (bal && bal.balance && bal.balance.packages) || []
              const total = bal && bal.balance ? bal.balance.total : undefined
              let balCell: React.ReactNode
              if (bal && bal.error !== undefined) {
                balCell = <span className={styles.err}>{bal.error}</span>
              } else if (!bal) {
                balCell = <span className={styles.muted}>—</span>
              } else if (!pkgs.length) {
                balCell = <span className={styles.muted}>无积分包</span>
              } else {
                balCell = pkgs.slice(0, 4).map((p: any, i: number) => {
                  if (p.active === false) {
                    return (
                      <div key={i} className={styles.pkgName}>
                        {p.name} <span className={styles.muted}>当前不可用</span>
                      </div>
                    )
                  }
                  const pct = p.total > 0 ? (p.remaining / p.total) * 100 : 0
                  const tone = pct > 30 ? "" : pct > 10 ? "warn" : "bad"
                  return (
                    <div key={i} className={styles.pkg}>
                      <div className={styles.pkgName}>
                        {p.name}{" "}
                        <span className={styles.muted}>
                          {fmt(p.remaining)}/{fmt(p.total)}
                        </span>
                      </div>
                      <div className={styles.bar}>
                        <i
                          className={clsx(tone ? styles[tone] : undefined)}
                          style={{ width: Math.min(100, pct).toFixed(1) + "%" }}
                        />
                      </div>
                    </div>
                  )
                })
              }
              let expCell: React.ReactNode
              if (a.expiresAt === undefined) {
                expCell = <span className={styles.muted}>到期时间未知{a.refreshable ? "（可续期）" : ""}</span>
              } else {
                const msLeft = a.expiresAt - Date.now()
                const tone = msLeft > 7 * 86400000 ? "ok" : msLeft > 2 * 86400000 ? "warn" : "bad"
                expCell = (
                  <>
                    <span className={clsx(styles.dot, styles[tone])} />
                    {a.expiryText || "已过期"}
                  </>
                )
              }
              const state = a.enabled ? (
                <>
                  <span className={clsx(styles.dot, styles.ok)} />
                  启用
                </>
              ) : (
                <>
                  <span className={clsx(styles.dot, styles.off)} />
                  停用
                </>
              )
              const rl =
                a.rateLimited > 0 ? (
                  <span title={a.rateLimitedModels || ""} className="c2a-warn">
                    {a.rateLimited} 模型限流
                  </span>
                ) : (
                  <span className={styles.muted}>正常</span>
                )
              return (
                <tr key={a.id}>
                  <td>
                    <ProviderHead provider={a.provider} />
                  </td>
                  <td>{a.nickname || a.id}</td>
                  <td className={styles.nowrap}>{state}</td>
                  <td className={styles.nowrap}>{expCell}</td>
                  <td>{rl}</td>
                  <td className={styles.num}>{total !== undefined ? <strong>{fmt(total)}</strong> : "—"}</td>
                  <td>{balCell}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

/* ── 积分收支 ─────────────────────────────────────────────────── */

export function CreditsSection({ data }: { data: any }) {
  const cr = data.credits
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  if (!cr || !cr.packages || cr.packages.length === 0) {
    return (
      <Section title="积分收支">
        <div className={styles.empty}>当前没有任何渠道上报积分包（或余额接口暂不可用）</div>
      </Section>
    )
  }
  const toggle = (prov: string, isOpen: boolean) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (isOpen) next.add(prov)
      else next.delete(prov)
      return next
    })
  }

  const unitCards = cr.units.map((u: any, i: number) => {
    const pctUsed = u.total > 0 ? (u.used / u.total) * 100 : 0
    return (
      <Card
        key={i}
        k={"可用结余 · " + u.unit}
        v={fmtAmt(u.remaining)}
        f={
          "已用 " +
          fmtAmt(u.used) +
          " / 总量 " +
          fmtAmt(u.total) +
          " · 使用率 " +
          pctUsed.toFixed(1) +
          "% · " +
          u.packs +
          " 个包"
        }
        tone={pctUsed >= 90 ? "bad" : pctUsed >= 60 ? "warn" : "ok"}
      />
    )
  })
  const warn7 = cr.expiry.d7.length
  const warn30 = cr.expiry.d30.length
  const undated = cr.expiry.undatedExpiring || []
  const stale = cr.expiry.expired.length
  const alerts: React.ReactNode[] = [
    <Card
      key="w7"
      k="7 天内到期"
      v={String(warn7)}
      u="个包"
      f={warn7 ? "其中剩余量见下方预警" : "暂无已知在 7 天内到期的包"}
      tone={warn7 ? "bad" : "ok"}
    />,
    <Card
      key="w30"
      k="8–30 天内到期"
      v={String(warn30)}
      u="个包"
      f={"合计 " + (warn7 + warn30) + " 个包在 30 天内到期"}
      tone={warn30 ? "warn" : ""}
    />,
  ]
  if (undated.length)
    alerts.push(
      <Card key="ud" k="即将到期（日期未知）" v={String(undated.length)} u="个包" f="临期额度见渠道明细" tone="warn" />,
    )
  if (stale)
    alerts.push(
      <Card key="st" k="已失效仍有账面余额" v={String(stale)} u="个包" f="相关额度已从可用结余扣除" tone="bad" />,
    )

  const chanMap = new Map<string, any[]>()
  cr.packages.forEach((p: any) => {
    if (!chanMap.has(p.provider)) chanMap.set(p.provider, [])
    chanMap.get(p.provider)!.push(p)
  })
  const grantTime = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })

  const chanBlocks = Array.from(chanMap.keys())
    .sort()
    .map((prov) => {
      const list = chanMap
        .get(prov)!
        .slice()
        .sort((a: any, b: any) => (b.remaining !== a.remaining ? b.remaining - a.remaining : a.name < b.name ? -1 : 1))
      const agg = { total: 0, used: 0, remaining: 0 }
      const units: string[] = []
      const accMap = new Map<string, any>()
      list.forEach((p: any) => {
        if (units.indexOf(p.unit) < 0) units.push(p.unit)
        const ak = p.accountId || "?"
        const a = accMap.get(ak) || { accountId: ak, nickname: p.nickname, total: 0, used: 0, remaining: 0, packs: 0 }
        if (p.active !== false) {
          agg.total += p.total
          agg.used += p.used
          agg.remaining += p.remaining
          a.total += p.total
          a.used += p.used
          a.remaining += p.remaining
        }
        a.packs += 1
        accMap.set(ak, a)
      })
      const pct = agg.total > 0 ? (agg.used / agg.total) * 100 : 0
      const tone = pct >= 90 ? "bad" : pct >= 60 ? "warn" : "brand"
      return (
        <details
          key={prov}
          className={styles.chan}
          data-prov={prov}
          open={open.has(prov)}
          onToggle={(e) => toggle(prov, (e.target as HTMLDetailsElement).open)}
        >
          <summary>
            <div className={styles.chanHead}>
              <ProviderHead provider={prov} />
              <span className={styles.unit}>{units.join(" · ")}</span>
              <span className={styles.chanSum}>
                {"收入 " +
                  fmtAmt(agg.total) +
                  " · 支出 " +
                  fmtAmt(agg.used) +
                  " · 可用结余 " +
                  fmtAmt(agg.remaining) +
                  " · 使用率 " +
                  pct.toFixed(1) +
                  "% · " +
                  list.length +
                  " 个包 / " +
                  accMap.size +
                  " 个账号"}
              </span>
            </div>
            <div className={clsx(styles.bar, "c2a-m0")}>
              <i
                className={clsx(tone ? styles[tone] : undefined)}
                style={{ width: Math.min(100, pct).toFixed(1) + "%" }}
              />
            </div>
          </summary>
          <div className={styles.chanBody}>
            {accMap.size > 1 ? (
              <div className={styles.accs}>
                {Array.from(accMap.values()).map((a: any) => (
                  <span key={a.accountId} className={styles.accItem}>
                    {a.nickname || a.accountId} · 可用结余 {fmtAmt(a.remaining)} / {fmtAmt(a.total)} · {a.packs} 个包
                  </span>
                ))}
              </div>
            ) : null}
            <div className={styles.tblWrap}>
              <table className={styles.tbl}>
                <thead>
                  <tr>
                    <th>包名</th>
                    <th>账号</th>
                    <th className={styles.num}>总量</th>
                    <th className={styles.num}>已用</th>
                    <th className={styles.num}>剩余</th>
                    <th>使用率</th>
                    <th>到期 / 重置</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p: any, i: number) => {
                    const up = p.total > 0 ? (p.used / p.total) * 100 : 0
                    const t = up >= 90 ? "bad" : up >= 60 ? "warn" : ""
                    const dl = leftDays(p.endAt)
                    const timing: string[] = []
                    if (p.expired || (dl !== null && dl < 0)) {
                      timing.push(dl !== null && dl < 0 ? when(p.endAt) + "（已过期）" : "已失效（日期未知）")
                    } else if (p.active === false) {
                      timing.push("当前不可用")
                    } else {
                      if (dl !== null) timing.push(when(p.endAt) + "（" + dl + " 天）")
                      else if (p.expiringRemaining > 0)
                        timing.push(fmtAmt(p.expiringRemaining) + " 即将到期（日期未知）")
                      else if (p.dailyGrantExpiresAt > Date.now())
                        timing.push("日奖励批次 " + grantTime.format(p.dailyGrantExpiresAt) + " 到期")
                      else if (p.expiryNote) timing.push(p.expiryNote)
                      else if (p.permanent) timing.push("无期限")
                      if (p.resetAt != null)
                        timing.push("重置时间 " + when(p.resetAt) + (p.resetAt <= Date.now() ? "（待更新）" : ""))
                    }
                    return (
                      <tr key={i}>
                        <td>{p.name}</td>
                        <td className={styles.muted}>{p.nickname || p.accountId || ""}</td>
                        <td className={styles.num}>{fmtAmt(p.total)}</td>
                        <td className={styles.num}>{fmtAmt(p.used)}</td>
                        <td className={styles.num}>{fmtAmt(p.remaining)}</td>
                        <td style={{ width: "13%" }}>
                          <div className={clsx(styles.bar, "c2a-m0")}>
                            <i
                              className={clsx(t ? styles[t] : undefined)}
                              style={{ width: Math.min(100, up).toFixed(1) + "%" }}
                            />
                          </div>
                        </td>
                        <td className={styles.muted}>{timing.join(" · ") || "到期时间未知"}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      )
    })

  const urgent = cr.expiry.d7.concat(cr.expiry.d30, undated).slice(0, 12)
  return (
    <Section title="积分收支">
      <Cards>
        {unitCards}
        {alerts}
      </Cards>
      <div className={styles.sub2}>
        {"按渠道明细（收入、支出和可用结余仅统计当前可用的包；共 " +
          chanMap.size +
          " 个渠道 / " +
          cr.packages.length +
          " 个积分包）"}
      </div>
      {chanBlocks}
      {urgent.length ? (
        <>
          <div className={styles.sub2}>即将到期（30 天内或日期未知）</div>
          <div className={styles.tblWrap}>
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>临期额度</th>
                  <th>包名</th>
                  <th>渠道 / 账号</th>
                  <th>到期</th>
                  <th>还剩</th>
                </tr>
              </thead>
              <tbody>
                {urgent.map((p: any, i: number) => {
                  const dl = leftDays(p.endAt)
                  const amount = dl === null ? p.expiringRemaining : p.remaining
                  const tone = dl !== null && dl <= 7 ? "bad" : "warn"
                  return (
                    <tr key={i}>
                      <td className={styles.num}>
                        {fmtAmt(amount)} <span className={styles.unit}>{p.unit}</span>
                      </td>
                      <td>{p.name}</td>
                      <td>
                        <span className={styles.chanCell}>
                          <ProviderHead provider={p.provider} />{" "}
                          <span className={styles.muted}>{p.nickname || p.accountId || ""}</span>
                        </span>
                      </td>
                      <td>{dl === null ? "日期未知" : when(p.endAt)}</td>
                      <td className={styles.nowrap}>
                        <span className={clsx(styles.dot, styles[tone])} />
                        {dl !== null ? dl + " 天" : "—"}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className={clsx(styles.muted, "c2a-text-xs")}>暂无可确认的临期额度。</div>
      )}
    </Section>
  )
}

/* ── 模型分布 ─────────────────────────────────────────────────── */

export function ModelsSection({ data }: { data: any }) {
  const models = data.models || []
  const byP: Record<string, number> = {}
  models.forEach((m: any) => {
    const p = String(m.id || "").split("/")[0] || "?"
    byP[p] = (byP[p] || 0) + 1
  })
  const sorted = Object.keys(byP)
    .map((k) => [k, byP[k]] as [string, number])
    .sort((a, b) => b[1] - a[1])
  const max = sorted.length ? sorted[0][1] : 1
  const used = (data.usage && data.usage.today && data.usage.today.models) || {}
  const usedSorted = Object.keys(used)
    .map((k) => [k, used[k]] as [string, number])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
  return (
    <Section title="模型分布">
      <div className={styles.two}>
        <div>
          {sorted.length ? (
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>渠道</th>
                  <th className={styles.num}>模型数</th>
                  <th>占比</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((x) => (
                  <tr key={x[0]}>
                    <td>
                      <ProviderHead provider={x[0]} />
                    </td>
                    <td className={styles.num}>{fmt(x[1])}</td>
                    <td style={{ width: "52%" }}>
                      <div className={clsx(styles.bar, "c2a-m0")}>
                        <i className={styles.brand} style={{ width: ((x[1] / max) * 100).toFixed(1) + "%" }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className={styles.empty}>模型清单为空</div>
          )}
        </div>
        <div>
          {usedSorted.length ? (
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>今日使用的模型</th>
                  <th className={styles.num}>请求数</th>
                </tr>
              </thead>
              <tbody>
                {usedSorted.map((x) => (
                  <tr key={x[0]}>
                    <td>
                      <span className={styles.ch}>{x[0]}</span>
                    </td>
                    <td className={styles.num}>{fmt(x[1])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className={styles.empty}>今天还没有调用</div>
          )}
        </div>
      </div>
    </Section>
  )
}

/* ── 自动签到 ─────────────────────────────────────────────────── */

export function checkinTone(text: string): "ok" | "warn" | "bad" {
  if (text.indexOf("已领") >= 0 || text.indexOf("已完成") >= 0 || text.indexOf("领取成功") >= 0) return "ok"
  if (/不支持|手动|未开启|未开放|无资格|未开始|活动结束|暂不可领/.test(text)) return "warn"
  return "bad"
}

export function CheckinSection({ data }: { data: any }) {
  const c = data.checkin
  if (!c) {
    return (
      <Section title="自动签到">
        <div className={styles.empty}>没有签到状态文件</div>
      </Section>
    )
  }
  const ok = c.ranToday === true
  const lag = typeof c.lagDays === "number" ? c.lagDays : null
  const lastText = !c.lastDate
    ? "还没有记录"
    : lag === 0
      ? "今天 " + c.lastDate
      : lag !== null && lag > 0
        ? "上次 " + c.lastDate + "（已隔 " + lag + " 天）"
        : "上次 " + c.lastDate
  const atText = typeof c.lastAt === "number" && c.lastAt > 0 ? when(c.lastAt) : "—"
  return (
    <Section title="自动签到">
      <Cards>
        <Card k="今日签到" v={ok ? "已完成" : "未完成"} f={lastText} tone={ok ? "ok" : "warn"} />
        <Card
          k="自动签到"
          v={c.enabled ? "已开启" : "已关闭"}
          f={
            Array.isArray(c.times) && c.times.length > 0
              ? c.times.join(" / ") + "（UTC+8，启动后补跑）"
              : "每天两个时段（启动后补跑）"
          }
          tone={c.enabled ? "ok" : "warn"}
        />
        <Card k="最近执行" v={atText} f={c.lastResult || "—"} tone={ok ? "" : "warn"} />
      </Cards>
      {lag !== null && lag > 0 && c.lastDate ? (
        <div className={clsx(styles.muted, "c2a-mt-6")}>
          ⚠️ 下表是 {c.lastDate} 那一轮的结果（已隔 {lag} 天），不是今天的快照；下一次自动签到跑完会重写。
        </div>
      ) : null}
      <table className={clsx(styles.tbl, "c2a-mt-8")}>
        <thead>
          <tr>
            <th>渠道</th>
            <th>签到状态</th>
          </tr>
        </thead>
        <tbody>
          {(c.channels || []).map((ch: any, i: number) => {
            const t = String(ch.text || "").replace(/^[0-9]+ *个 *未开启$/, "活动未开启")
            return (
              <tr key={i}>
                <td>
                  <span className={styles.ch}>{ch.provider}</span>
                </td>
                <td>
                  <span className={clsx(styles.dot, styles[checkinTone(t)])} />
                  {t}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Section>
  )
}

import clsx from "clsx"
import { useEffect, useState } from "react"

import { type CallerState } from "../../api/callers"
import { autoMs as getAutoMs, type Filter } from "../../hooks/useCallersData"
import { dayHead, fmt, fmtMs, fmtTokens, localDay, recKey, statusReason } from "../../utils/callers-format"
import { hhmmss } from "../../utils/time"
import { DaysDropdown } from "./DaysDropdown"
import { Section } from "./Section"
import styles from "./RecordsTab.module.less"

/* ── 调用记录 ─────────────────────────────────────────────────── */

function callerName(data: CallerState | null, id: string): string {
  if (id === "master") return "超管"
  const k = ((data && data.keys) || []).filter((x) => x.id === id)[0]
  return k && k.name ? k.name : id
}

export function RecordsTab(props: {
  data: CallerState | null
  records: any
  filter: Filter
  setFilter: (f: Filter) => void
  days: string[]
  daysOpen: boolean
  setDaysOpen: (v: boolean) => void
  toggleDay: (d: string) => void
  applyPreset: (k: string) => void
  applyQuery: () => void
  autoOn: boolean
  toggleAuto: () => void
  autoBusy: boolean
  autoErr: string
  lastAt: number
  fresh: Record<string, 1>
  autoBlock: () => string
  modelCandidates: string[]
}) {
  const {
    data,
    records,
    filter,
    setFilter,
    days,
    daysOpen,
    setDaysOpen,
    toggleDay,
    applyPreset,
    applyQuery,
    autoOn,
    toggleAuto,
    autoBusy,
    autoErr,
    lastAt,
    fresh,
    autoBlock,
    modelCandidates,
  } = props
  const [, force] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => force((x) => x + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!records) return <div className={styles.empty}>加载中…</div>

  const availDays: string[] = records.availableDays || []
  const cf = filter.caller
  const mf = filter.model
  const sf = filter.status
  const dataKeys = (data && data.keys) || []
  const modelList = (
    modelCandidates && modelCandidates.length ? modelCandidates : (records.byModel || []).map((m: any) => m.model)
  )
    .slice()
    .sort()

  const block = autoBlock()
  let autoText = ""
  let mode = "on"
  if (block === "off") {
    autoText = "自动刷新已暂停"
    mode = "off"
  } else if (block === "days") {
    autoText = "正在选日期，自动刷新暂停"
    mode = "wait"
  } else if (block === "dirty") {
    autoText = "筛选已改动，点「查询」后继续自动刷新"
    mode = "wait"
  } else if (autoBusy) {
    autoText = "正在刷新…"
    mode = "on"
  } else if (autoErr) {
    autoText = "刷新失败：" + autoErr + "，稍后自动重试"
    mode = "err"
  } else {
    const s = lastAt ? Math.max(0, Math.round((Date.now() - lastAt) / 1000)) : 0
    autoText =
      "每 " + Math.max(1, Math.round(getAutoMs() / 1000)) + " 秒自动刷新 · " + (s < 2 ? "刚刚更新" : s + " 秒前更新")
    mode = "on"
  }

  const maxMs = (records.rows || []).reduce((m: number, x: any) => {
    const v = Number(x.ms)
    return x.ms != null && isFinite(v) && v > m ? v : m
  }, 0)

  const byModel = (records.byModel || []).slice(0, 12)
  const maxAvg = (records.byModel || []).reduce((n: number, m: any) => Math.max(n, Number(m.avgMs) || 0), 0)
  const detailRows: any[] = records.rows || []
  const bad = (records.byModel || []).reduce((n: number, m: any) => n + (Number(m.errors) || 0), 0)

  let lastDay = ""
  const seen: Record<string, number> = {}

  return (
    <>
      <div className={styles.filters}>
        <DaysDropdown
          days={days}
          daysOpen={daysOpen}
          setOpen={setDaysOpen}
          availableDays={availDays}
          toggleDay={toggleDay}
          applyPreset={applyPreset}
        />
        <div className={styles.field}>
          <label>调用方</label>
          <select value={cf} onChange={(e) => setFilter({ ...filter, caller: e.target.value })}>
            <option value="">全部调用方</option>
            {dataKeys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.id + " · " + k.name}
              </option>
            ))}
            <option value="master">master · 上游网关主 key</option>
          </select>
        </div>
        <div className={styles.field}>
          <label>模型</label>
          <select value={mf} onChange={(e) => setFilter({ ...filter, model: e.target.value })}>
            <option value="">全部模型</option>
            {modelList.map((id: string) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label>结果</label>
          <select value={sf} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
            <option value="">全部</option>
            <option value="ok">成功</option>
            <option value="error">失败</option>
          </select>
        </div>
        <div className={clsx(styles.field, styles.fieldAct)}>
          <label>&nbsp;</label>
          <button className="dim-jh-btn" data-act="rec-apply" onClick={applyQuery}>
            查询
          </button>
        </div>
        <div className={styles.auto} data-mode={mode}>
          <span className={styles.autodot} />
          <span>{autoText}</span>
          <button type="button" className="dim-jh-btn" data-act="rec-auto" onClick={toggleAuto}>
            {autoOn ? "暂停" : "继续"}
          </button>
        </div>
      </div>

      <div className={styles.split}>
        <div className={clsx(styles.pane, styles.paneLeft)}>
          <Section title={"按模型汇总 · 共 " + fmt(records.total || 0) + " 次调用"}>
            <div className={styles.paneScroll}>
              {byModel.length ? (
                <table className={clsx(styles.tbl, styles.modeltbl)}>
                  <thead>
                    <tr>
                      <th className={styles.mModel}>模型</th>
                      <th className={clsx(styles.num, styles.mCalls)}>调用</th>
                      <th className={clsx(styles.num, styles.mTok)}>token</th>
                      <th className={clsx(styles.num, styles.mAvg)}>平均耗时</th>
                      <th className={styles.mWho}>谁在调</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byModel.map((m: any, i: number) => {
                      const model = String(m.model || "")
                      const cut = model.indexOf("/")
                      const prov = cut > 0 ? model.slice(0, cut) : ""
                      const short = cut > 0 ? model.slice(cut + 1) : model
                      const calls = Number(m.calls) || 0
                      const hasAvg = m.avgMs != null && isFinite(Number(m.avgMs))
                      const avgPct =
                        hasAvg && maxAvg > 0 ? Math.max(2, Math.round((Number(m.avgMs) / maxAvg) * 100)) : 0
                      const who = Object.keys(m.byCaller || {}).sort((a, b) => m.byCaller[b] - m.byCaller[a])
                      return (
                        <tr key={i}>
                          <td>
                            <span className={styles.recmodel} title={model}>
                              <span className={styles.recname}>{short}</span>
                              {prov ? <span className={styles.recprov}>{prov}</span> : null}
                            </span>
                          </td>
                          <td className={styles.num}>
                            <span className={styles.mcalls}>{fmt(calls)}</span>
                            {m.errors > 0 ? <span className={styles.merr}>失败 {fmt(m.errors)}</span> : null}
                          </td>
                          <td className={styles.num}>
                            <span className={styles.mtok}>
                              <span>输入</span>
                              {fmtTokens(m.inTokens)}
                            </span>
                            <span className={styles.mtok}>
                              <span>输出</span>
                              {fmtTokens(m.outTokens)}
                            </span>
                          </td>
                          <td className={styles.num}>
                            <span className={styles.recms}>
                              {fmtMs(m.avgMs)}
                              {hasAvg ? (
                                <span className={clsx(styles.recbar, Number(m.avgMs) >= 10000 && styles.slow)}>
                                  <i style={{ width: avgPct + "%" }} />
                                </span>
                              ) : null}
                            </span>
                          </td>
                          <td>
                            <div className={styles.mwhos}>
                              {who.slice(0, 3).map((c, wi) => (
                                <span
                                  key={c}
                                  className={clsx(styles.mwho, wi > 0 && styles.wide)}
                                  title={callerName(data, c) + " · " + c}
                                >
                                  <span className={styles.n}>{callerName(data, c)}</span>
                                  <b>{fmt(m.byCaller[c])}</b>
                                </span>
                              ))}
                              {who.length > 3 ? (
                                <span className={clsx(styles.mwho, styles.more, styles.wide)}>+{who.length - 3}</span>
                              ) : who.length > 1 ? (
                                <span className={clsx(styles.mwho, styles.more, styles.narrow)}>+{who.length - 1}</span>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <div className={styles.empty}>暂无数据</div>
              )}
            </div>
          </Section>
        </div>

        <div className={clsx(styles.pane, styles.paneRight)}>
          <Section
            title={
              "逐条明细 · 最近 " +
              fmt(records.shown || 0) +
              " / 共 " +
              fmt(records.total || 0) +
              " 条" +
              (bad > 0 ? " · 失败 " + fmt(bad) : "")
            }
          >
            <div className={styles.paneScroll}>
              {detailRows.length ? (
                <table className={clsx(styles.tbl, styles.rectbl)}>
                  <thead>
                    <tr>
                      <th className={styles.cTime}>时间</th>
                      <th className={styles.cWho}>调用方</th>
                      <th className={styles.cModel}>模型</th>
                      <th className={styles.cRes}>结果</th>
                      <th className={clsx(styles.num, styles.cMs)}>耗时</th>
                      <th className={clsx(styles.num, styles.cIn)}>输入</th>
                      <th className={clsx(styles.num, styles.cOut)}>输出</th>
                      <th className={styles.cWay}>方式</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailRows.map((x: any, i: number) => {
                      const day = localDay(x.ts) || x.day || ""
                      const dayHeader = day !== lastDay ? <DayHeader key={"d" + day + i} day={day} /> : null
                      if (day !== lastDay) lastDay = day
                      const base = recKey(x)
                      seen[base] = (seen[base] || 0) + 1
                      return (
                        <FragmentRow key={base + "#" + seen[base]}>
                          {dayHeader}
                          <DetailRow x={x} maxMs={maxMs} isNew={Boolean(fresh[recKey(x)])} />
                        </FragmentRow>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <div className={styles.empty}>所选日期内没有调用记录</div>
              )}
            </div>
          </Section>
        </div>
      </div>
      <p className={clsx(styles.muted, "c2a-text-xs", "c2a-mt-6")}>
        记录只含元数据（调用方、模型、状态、耗时、token 数），<strong>不落 prompt / 回复正文</strong>
        。日期多选可跨天查询，最多 31 天。
      </p>
    </>
  )
}

// <tbody> 里拼「日期分组行 + 明细行」用 Fragment（不能包一层 div）。
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
function DayHeader({ day }: { day: string }) {
  return (
    <tr className={styles.recday}>
      <td colSpan={8}>{dayHead(day)}</td>
    </tr>
  )
}
function DetailRow({ x, maxMs, isNew }: { x: any; maxMs: number; isNew: boolean }) {
  const bad = Number(x.status) >= 400
  const model = String(x.model || "")
  const cut = model.indexOf("/")
  const prov = cut > 0 ? model.slice(0, cut) : ""
  const short = cut > 0 ? model.slice(cut + 1) : model
  const master = x.caller === "master"
  const who = master ? "超管" : x.name || x.caller || "—"
  const whoSub = master ? "上游网关主 key" : x.name ? x.caller : ""
  const ms = Number(x.ms)
  const hasMs = x.ms != null && isFinite(ms)
  const pct = hasMs && maxMs > 0 ? Math.max(2, Math.round((ms / maxMs) * 100)) : 0
  const barCls = bad ? " bad" : hasMs && ms >= 10000 ? " slow" : ""
  const outTok = bad && !Number(x.out_tokens) ? "—" : fmtTokens(x.out_tokens)
  const inTok = x.in_tokens == null ? "—" : fmtTokens(x.in_tokens)
  return (
    <tr className={clsx(styles.recrow, bad && styles.bad, isNew && styles.fresh)}>
      <td className={styles.cTime}>
        <span className={styles.rectime}>{hhmmss(x.ts)}</span>
        {isNew ? <span className={styles.recnew}>新</span> : null}
      </td>
      <td className={styles.cWho}>
        <span className={styles.recwho} title={who}>
          {who}
        </span>
        {whoSub ? <span className={styles.recsub}>{whoSub}</span> : null}
      </td>
      <td className={styles.cModel}>
        <span className={styles.recmodel} title={model}>
          <span className={styles.recname}>{short}</span>
          {prov ? <span className={styles.recprov}>{prov}</span> : null}
        </span>
      </td>
      <td className={styles.cRes}>
        {bad ? (
          <span className={styles.recbad}>
            <span className={clsx(styles.badge, styles.bad)}>{x.status}</span>
            <span className={styles.recwhy} title={x.error_code || statusReason(x)}>
              {statusReason(x)}
            </span>
          </span>
        ) : (
          <span className={styles.recok} title={"HTTP " + x.status}>
            ✓ 成功
          </span>
        )}
      </td>
      <td className={clsx(styles.cMs, styles.num)}>
        <span className={styles.recms}>
          {fmtMs(x.ms)}
          {hasMs ? (
            <span className={clsx(styles.recbar, barCls.trim() && styles[barCls.trim()])}>
              <i style={{ width: pct + "%" }} />
            </span>
          ) : null}
        </span>
      </td>
      <td className={clsx(styles.cIn, styles.num)}>
        <span className={styles.rectok}>{inTok}</span>
      </td>
      <td className={clsx(styles.cOut, styles.num)}>
        <span className={styles.rectok}>{outTok}</span>
      </td>
      <td className={styles.cWay}>
        <span className={clsx(styles.recway, x.stream && styles.stream)}>{x.stream ? "流式" : "一次性"}</span>
      </td>
    </tr>
  )
}

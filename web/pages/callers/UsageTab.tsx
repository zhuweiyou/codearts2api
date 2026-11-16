import clsx from "clsx"

import { type CallerState } from "../../api/callers"
import { fmt, fmtTokens } from "../../utils/callers-format"
import { Section } from "./Section"
import styles from "./UsageTab.module.less"

/* ── 用量 ─────────────────────────────────────────────────────── */

export function UsageTab({ data }: { data: CallerState | null }) {
  if (!data) return <div className={styles.empty}>加载中…</div>
  const u = data.usage || { day: "", rows: [] }
  return (
    <>
      <Section title={"按调用方汇总 · " + (u.day || "")}>
        <div className={styles.tblWrap}>
          <table className={styles.tbl}>
            <thead>
              <tr>
                <th>key</th>
                <th>名字</th>
                <th>分组</th>
                <th className={styles.num}>次数</th>
                <th className={styles.num}>in</th>
                <th className={styles.num}>out</th>
                <th className={styles.num}>错误</th>
                <th>模型</th>
              </tr>
            </thead>
            <tbody>
              {(u.rows || []).map((rr: any, i: number) => {
                const isMaster = rr.caller === "master"
                return (
                  <tr key={i}>
                    <td className={styles.mono}>
                      {rr.caller}
                      {isMaster ? <span className={clsx(styles.badge, styles.off)}>超管</span> : null}
                    </td>
                    <td>{rr.name}</td>
                    <td>{rr.group}</td>
                    <td className={styles.num}>{fmt(rr.calls)}</td>
                    <td className={styles.num}>{fmtTokens(rr.inTokens)}</td>
                    <td className={styles.num}>{fmtTokens(rr.outTokens)}</td>
                    <td className={styles.num}>{rr.errors > 0 ? <span className="c2a-err">{rr.errors}</span> : "0"}</td>
                    <td className={clsx(styles.mono, "c2a-text-2xs")}>
                      {(rr.models || []).slice(0, 3).join(", ")}
                      {(rr.models || []).length > 3 ? " +" + ((rr.models || []).length - 3) : ""}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>
      <p className={clsx(styles.muted, "c2a-text-xs", "c2a-mt-8")}>
        流水按天落盘，路径 <code>{data.storePath || ""}</code> 同级 <code>caller-usage/</code>。
        看逐次明细、按模型汇总与历史日期，请切到「调用记录」页签。
      </p>
    </>
  )
}

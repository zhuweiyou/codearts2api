import clsx from "clsx"

import { type CallerState } from "../../api/callers"
import { Section } from "./Section"
import styles from "./GroupsTab.module.less"

/* ── 分组 ─────────────────────────────────────────────────────── */

export function GroupsTab({
  data,
  onNew,
  onEdit,
  onRemove,
}: {
  data: CallerState | null
  onNew: () => void
  onEdit: (g: any) => void
  onRemove: (name: string) => void
}) {
  if (!data) return <div className={styles.empty}>加载中…</div>
  return (
    <>
      <Section title="分组（白名单）">
        <div className={styles.tblWrap}>
          <table className={clsx(styles.tbl, styles.tblFixed)}>
            <colgroup>
              <col style={{ width: "11%" }} />
              <col style={{ width: "20%" }} />
              <col />
              <col style={{ width: "112px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>分组名</th>
                <th>说明</th>
                <th>允许的模型</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {(data.groups || []).map((g) => {
                const allow = Array.isArray(g.allow) ? g.allow : []
                return (
                  <tr key={g.name}>
                    <td>
                      <strong>{g.name}</strong>
                    </td>
                    <td className={styles.wrap}>{g.desc || ""}</td>
                    <td>
                      <div className={styles.chips}>
                        {allow.length ? (
                          allow.map((a) => (
                            <span key={a} className={styles.chip}>
                              {a}
                            </span>
                          ))
                        ) : (
                          <span className={styles.muted}>无（全部拒绝）</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className={styles.ops}>
                        <button className="dim-jh-btn" data-act="group-edit" onClick={() => onEdit(g)}>
                          编辑
                        </button>
                        <button className="dim-jh-btn" data-act="group-rm" onClick={() => onRemove(g.name)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>
      <div className="c2a-mt-8">
        <button className="dim-jh-btn" data-act="group-new" onClick={onNew}>
          + 新建分组
        </button>
      </div>
      <p className={clsx(styles.muted, "c2a-text-xs", "c2a-mt-8")}>
        白名单支持 <code>*</code>（全部）、<code>provider/*</code>（某渠道全部）、完整模型名。
        <code>aggregate/*</code> 与 <code>jet-hub-auto/*</code> 在白名单不是 <code>*</code> 时必须显式列出。
      </p>
    </>
  )
}

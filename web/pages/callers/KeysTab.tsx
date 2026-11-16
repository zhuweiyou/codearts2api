import clsx from "clsx"

import { type CallerState } from "../../api/callers"
import { Section } from "./Section"
import styles from "./KeysTab.module.less"

/* ── Key ──────────────────────────────────────────────────────── */

export function KeysTab({
  data,
  onNew,
  onEdit,
  onRemove,
}: {
  data: CallerState | null
  onNew: () => void
  onEdit: (k: any) => void
  onRemove: (id: string) => void
}) {
  if (!data) return <div className={styles.empty}>加载中…</div>
  const keys = data.keys || []
  return (
    <>
      <Section title={"调用方 Key（" + keys.length + " 个）"}>
        <div className={styles.tblWrap}>
          <table className={clsx(styles.tbl, styles.tblFixed)}>
            <colgroup>
              <col style={{ width: "13%" }} />
              <col />
              <col style={{ width: "11%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "112px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>id</th>
                <th>名字</th>
                <th>分组</th>
                <th>状态</th>
                <th>指纹</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td className={styles.mono}>{k.id}</td>
                  <td className={styles.wrap}>{k.name}</td>
                  <td>{k.group}</td>
                  <td>
                    {k.enabled ? (
                      <span className={clsx(styles.badge, styles.ok)}>启用</span>
                    ) : (
                      <span className={clsx(styles.badge, styles.off)}>停用</span>
                    )}
                  </td>
                  <td className={styles.mono}>{k.sha}…</td>
                  <td className={styles.nowrap}>{k.createdAt ? new Date(k.createdAt).toLocaleString("zh-CN") : "—"}</td>
                  <td>
                    <div className={styles.ops}>
                      <button className="dim-jh-btn" data-act="key-edit" onClick={() => onEdit(k)}>
                        编辑
                      </button>
                      <button className="dim-jh-btn" data-act="key-rm" onClick={() => onRemove(k.id)}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <div className="c2a-mt-8">
        <button className="dim-jh-btn" data-act="key-new" onClick={onNew}>
          + 新建 Key
        </button>
      </div>
      {keys.length === 0 ? (
        <p className={clsx(styles.muted, "c2a-text-xs", "c2a-mt-8")}>
          还没有任何调用方 Key。超管 key（网关主 key）不需要在这里建，它始终可用且会照常计入用量。
        </p>
      ) : null}
    </>
  )
}

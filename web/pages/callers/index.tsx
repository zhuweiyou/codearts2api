/**
 * 调用方视图 —— 主组件（数据在 hooks/useCallersData；各页签在 ./GroupsTab / ./KeysTab / ./UsageTab / ./RecordsTab）。
 */
import clsx from "clsx"
import { useState } from "react"

import { addKey, removeGroup, removeKey, saveGroup, updateKey, type CallerState } from "../../api/callers"
import { useCallersData, type CallersTab } from "../../hooks/useCallersData"
import { FormModal, type FormField } from "./FormModal"
import { GroupsTab } from "./GroupsTab"
import { KeysTab } from "./KeysTab"
import { RecordsTab } from "./RecordsTab"
import { SecretModal } from "./SecretModal"
import { UsageTab } from "./UsageTab"
import styles from "./Callers.module.less"

/* ── 主组件 ───────────────────────────────────────────────────── */

type ModalState =
  | { kind: "group"; mode: "new" | "edit"; target?: any }
  | { kind: "key"; mode: "new" | "edit"; target?: any }
  | null

export default function Callers({ active = true }: { active?: boolean }) {
  const [tab, setTab] = useState<CallersTab>("groups")
  const [modal, setModal] = useState<ModalState>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const d = useCallersData(active, tab)

  const TABS: { key: CallersTab; label: string; count?: (s: CallerState) => number }[] = [
    { key: "groups", label: "分组", count: (s) => (s.groups || []).length },
    { key: "keys", label: "Key", count: (s) => (s.keys || []).length },
    { key: "usage", label: "用量" },
    { key: "records", label: "调用记录" },
  ]

  const switchTab = (k: CallersTab) => {
    setTab(k)
    d.setDaysOpen(false)
    if (k === "records" && !d.records) d.refresh("records")
  }

  const removeGroupByName = async (name: string) => {
    if (!confirm("删除分组 " + name + "？被 Key 引用时会拒绝。")) return
    try {
      await removeGroup(name)
      await d.refresh("state")
    } catch (e: any) {
      alert(e.message)
    }
  }
  const removeKeyById = async (id: string) => {
    if (!confirm("删除 Key " + id + "？删掉后它立刻不能调用。")) return
    try {
      await removeKey(id)
      await d.refresh("state")
    } catch (e: any) {
      alert(e.message)
    }
  }

  const groupFields = (g: any): FormField[] => [
    { key: "name", label: "分组名", value: g ? g.name : "", hint: "建好后不建议改名（Key 按名字引用它）" },
    { key: "desc", label: "说明", value: g ? g.desc : "" },
    {
      key: "allow",
      label: "白名单（逗号或换行分隔）",
      type: "textarea",
      value: g ? (g.allow || []).join("\n") : "*",
      hint: "* = 全部；provider/* = 该渠道全部；也可写完整模型名",
    },
  ]
  const keyFields = (k: any): FormField[] => {
    let groups = ((d.data && d.data.groups) || []).map((g) => ({
      value: g.name,
      label: g.name + (g.desc ? " · " + g.desc : ""),
    }))
    if (groups.length === 0) groups = [{ value: "full", label: "full（还没有分组，先建分组）" }]
    return [
      { key: "name", label: "名字（给谁用）", value: k ? k.name : "" },
      {
        key: "group",
        label: "分组（决定能调哪些模型）",
        type: "select",
        options: groups,
        value: k ? k.group : groups[0].value,
      },
      {
        key: "enabled",
        label: "状态",
        type: "select",
        options: [
          { value: "true", label: "启用" },
          { value: "false", label: "停用" },
        ],
        value: k && k.enabled === false ? "false" : "true",
      },
    ]
  }
  const splitAllow = (text: string) =>
    String(text || "")
      .split(/[\n,、;；]+/)
      .map((s) => s.trim())
      .filter(Boolean)

  const modalTitle = () => {
    if (!modal) return ""
    if (modal.kind === "group") return modal.mode === "new" ? "新建分组" : "编辑分组 · " + modal.target.name
    return modal.mode === "new" ? "新建 Key" : "编辑 Key · " + modal.target.id
  }
  const modalFields = (): FormField[] => {
    if (!modal) return []
    if (modal.kind === "group") return groupFields(modal.mode === "edit" ? modal.target : null)
    return keyFields(modal.mode === "edit" ? modal.target : null)
  }
  const submitModal = async (v: Record<string, string>) => {
    if (!modal) return
    if (modal.kind === "group") {
      const name = modal.mode === "edit" ? modal.target.name : v.name.trim()
      await saveGroup(name, v.desc, splitAllow(v.allow))
      await d.refresh("state")
    } else if (modal.mode === "new") {
      const out = await addKey({ name: v.name.trim(), group: v.group, enabled: v.enabled === "true" })
      await d.refresh("state")
      if (out && out.secret) setSecret(out.secret)
    } else {
      await updateKey({ id: modal.target.id, name: v.name.trim(), group: v.group, enabled: v.enabled === "true" })
      await d.refresh("state")
    }
  }

  const sub = d.data ? (d.data.keys || []).length + " 个 Key · " + (d.data.groups || []).length + " 个分组" : "加载中…"

  return (
    <section className="c2a-view" id="c2a-view-callers" data-view="callers" role="tabpanel" aria-label="调用方">
      <div className="c2a-page">
        <div className="c2a-page-head">
          <div>
            <h1 className="c2a-page-title">调用方</h1>
            <p className="c2a-page-sub">
              <span>{sub}</span> · 分组决定能用哪些模型，Key 决定谁在调；用量与调用记录按 Key / 模型实时汇总，超管 Key
              一并统计。
            </p>
          </div>
          <div className="c2a-page-actions">
            <button type="button" className="c2a-btn" onClick={() => d.refresh()}>
              刷新
            </button>
          </div>
        </div>

        <div className={clsx(styles.scope, styles.body)}>
          <div className={styles.tabs}>
            {TABS.map((t) => {
              const n = d.data && t.count ? t.count(d.data) : null
              return (
                <button
                  key={t.key}
                  className={clsx(styles.tab, tab === t.key && styles.on)}
                  onClick={() => switchTab(t.key)}
                >
                  {t.label}
                  {n !== null ? <span className={styles.n}>{n}</span> : null}
                </button>
              )
            })}
          </div>

          {d.loadError ? (
            <div className={styles.empty}>加载失败：{d.loadError}</div>
          ) : tab === "groups" ? (
            <GroupsTab
              data={d.data}
              onNew={() => setModal({ kind: "group", mode: "new" })}
              onEdit={(g) => setModal({ kind: "group", mode: "edit", target: g })}
              onRemove={removeGroupByName}
            />
          ) : tab === "keys" ? (
            <KeysTab
              data={d.data}
              onNew={() => setModal({ kind: "key", mode: "new" })}
              onEdit={(k) => setModal({ kind: "key", mode: "edit", target: k })}
              onRemove={removeKeyById}
            />
          ) : tab === "usage" ? (
            <UsageTab data={d.data} />
          ) : (
            <RecordsTab
              data={d.data}
              records={d.records}
              filter={d.filter}
              setFilter={d.setFilter}
              days={d.days}
              daysOpen={d.daysOpen}
              setDaysOpen={d.setDaysOpen}
              toggleDay={d.toggleDay}
              applyPreset={d.applyPreset}
              applyQuery={() => d.refresh("records")}
              autoOn={d.autoOn}
              toggleAuto={d.toggleAuto}
              autoBusy={d.autoBusy}
              autoErr={d.autoErr}
              lastAt={d.lastAt}
              fresh={d.fresh}
              autoBlock={d.autoBlock}
              modelCandidates={d.modelCandidates}
            />
          )}
        </div>

        {modal ? (
          <FormModal title={modalTitle()} fields={modalFields()} onOk={submitModal} onClose={() => setModal(null)} />
        ) : null}
        {secret ? <SecretModal secret={secret} onClose={() => setSecret(null)} /> : null}
      </div>
    </section>
  )
}

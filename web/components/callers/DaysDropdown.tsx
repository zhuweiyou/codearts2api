import clsx from "clsx"
import { useEffect, useRef } from "react"

import { daysText, presetSet, sameSet, wd } from "../../utils/callers-format"
import styles from "./Callers.module.less"

const PRESETS: [string, string][] = [
  ["latest", "最近一天"],
  ["3", "最近 3 天"],
  ["7", "最近 7 天"],
  ["all", "全部"],
  ["none", "清空"],
]

export function DaysDropdown({
  days,
  daysOpen,
  setOpen,
  availableDays,
  toggleDay,
  applyPreset,
}: {
  days: string[]
  daysOpen: boolean
  setOpen: (v: boolean) => void
  availableDays: string[]
  toggleDay: (day: string) => void
  applyPreset: (kind: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // 点击面板外部即收起（不吞这次点击）；与旧外壳 handleDaysClick 行为一致。
  useEffect(() => {
    if (!daysOpen) return
    function onDocMouseDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocMouseDown)
    return () => document.removeEventListener("mousedown", onDocMouseDown)
  }, [daysOpen, setOpen])

  return (
    <div className={clsx(styles.field, styles.fieldDays)} ref={wrapRef}>
      <label>日期（可多选，最多 31 天）</label>
      <div className={styles.dd} data-open={daysOpen ? "1" : "0"}>
        <button type="button" className={styles.ddbtn} onClick={() => setOpen(!daysOpen)}>
          <span>{daysText(days)}</span>
          <span className={styles.ddarrow}>▾</span>
        </button>
        <div className={styles.ddpanel} hidden={!daysOpen}>
          <div className={styles.ddpre}>
            {PRESETS.map(([kind, label]) => {
              const on = sameSet(presetSet(kind, availableDays) || [], days)
              return (
                <button
                  key={kind}
                  type="button"
                  className={clsx(styles.preset, on && styles.on)}
                  onClick={() => applyPreset(kind)}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <div className={styles.ddlist}>
            {availableDays.length === 0 ? (
              <div className={styles.ddempty}>还没有任何调用日志</div>
            ) : (
              availableDays.map((day) => (
                <div
                  key={day}
                  className={clsx(styles.ddrow, days.indexOf(day) >= 0 && styles.on)}
                  onClick={() => toggleDay(day)}
                >
                  <span className={styles.ddbox} />
                  <span className={styles.ddlab}>{day}</span>
                  <span className={styles.ddw}>{wd(day)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

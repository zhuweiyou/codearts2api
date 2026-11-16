import clsx from "clsx"

import styles from "./Card.module.less"

export function Card({
  k: label,
  v: value,
  u: unit,
  f: footnote,
  tone,
}: {
  k: React.ReactNode
  v: React.ReactNode
  u?: React.ReactNode
  f?: React.ReactNode
  tone?: string
}) {
  return (
    <div className={clsx(styles.card, tone ? styles[tone] : undefined)}>
      <div className={styles.k}>{label}</div>
      <div className={styles.v}>
        {value}
        {unit ? <span className={styles.u}>{unit}</span> : null}
      </div>
      {footnote ? <div className={styles.f}>{footnote}</div> : null}
    </div>
  )
}

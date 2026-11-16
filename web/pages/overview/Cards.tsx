import clsx from "clsx"

import styles from "./Overview.module.less"

export function Cards({ children }: { children: React.ReactNode }) {
  const count = Array.isArray(children) ? children.flat().filter(Boolean).length : 1
  return <div className={clsx(styles.cards, count === 6 ? styles.cards6 : undefined)}>{children}</div>
}

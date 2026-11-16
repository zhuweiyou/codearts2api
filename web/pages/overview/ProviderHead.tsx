import { providerIconUrl, providerLabel } from "../../api/providers"
import styles from "./Overview.module.less"

export function ProviderHead({ provider }: { provider: string }) {
  const url = providerIconUrl(provider)
  return (
    <span className={styles.chanCell}>
      {url ? (
        <span className={styles.ico}>
          <img src={url} alt="" />
        </span>
      ) : null}
      <span className={styles.chanName}>{providerLabel(provider)}</span>
      <span className={styles.ch}>{provider}</span>
    </span>
  )
}

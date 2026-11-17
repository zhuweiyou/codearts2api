/**
 * 总览视图 —— 主组件（数据在 hooks/useOverviewData，各分区在 ./sections，原子在 ./Card 等）。
 */
import { useOverviewData } from "../../hooks/useOverviewData"
import {
  AccountsSection,
  CheckinSection,
  CreditsSection,
  GatewaySection,
  ModelsSection,
  TrendSection,
  UsageSection,
} from "./sections"
import styles from "./index.module.less"

/* ── 主组件 ───────────────────────────────────────────────────── */

export default function Overview({ active = true }: { active?: boolean }) {
  const { snapshot, summary, error, busy, refresh } = useOverviewData(active)

  return (
    <section className="c2a-view" id="c2a-view-overview" data-view="overview" role="tabpanel" aria-label="总览">
      <div className="c2a-page" data-c2a-page="overview">
        <div className="c2a-page-head">
          <div>
            <h1 className="c2a-page-title">总览</h1>
            <p className="c2a-page-sub">{summary}</p>
          </div>
          <div className="c2a-page-actions">
            <button
              type="button"
              className="c2a-btn"
              title="重新读取全部数据（余额会绕过 5 分钟缓存）。"
              onClick={refresh}
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? "正在刷新…" : "刷新"}
            </button>
          </div>
        </div>
        <div className={styles.body}>
          {snapshot ? (
            <>
              <GatewaySection data={snapshot} />
              <UsageSection data={snapshot} />
              <TrendSection data={snapshot} />
              <AccountsSection data={snapshot} />
              <CreditsSection data={snapshot} />
              <ModelsSection data={snapshot} />
              <CheckinSection data={snapshot} />
            </>
          ) : error ? (
            <div className={styles.empty}>加载失败：{error}</div>
          ) : (
            <div className={styles.empty}>加载中…</div>
          )}
        </div>
      </div>
    </section>
  )
}

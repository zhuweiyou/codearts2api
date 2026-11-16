/**
 * 渠道元数据：直接由上游 `dsh-providers-hub` 的 `PROVIDER_REGISTRY` 派生（零 import 的纯数据），
 * 避免本仓库手写中文名映射与上游漂移。通过 vite.config 的 `resolve.alias` 指向该文件。
 */
import { PROVIDER_REGISTRY } from "dsh-providers-hub/provider-registry"

interface ProviderMeta {
  id: string
  label?: string
  displayName?: string
}

export const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  (PROVIDER_REGISTRY as ProviderMeta[]).map((p) => [p.id, p.label || p.displayName || p.id]),
)

/** 中文名：优先读左侧原生供应商行（运行时最准），否则用上游注册表派生值。 */
export function providerLabel(provider: string): string {
  const row = document.querySelector('.dim-jh-providerRow[data-provider="' + provider + '"]')
  const txt = row && row.querySelector(".dim-jh-providerLabel strong")
  if (txt && txt.textContent && txt.textContent.trim()) return txt.textContent.trim()
  return PROVIDER_LABELS[provider] ?? provider
}

/** 渠道 logo：借左侧原生供应商行里的同源内联图，不发请求。 */
export function providerIconUrl(provider: string): string {
  const img = document.querySelector(
    '.dim-jh-providerRow[data-provider="' + provider + '"] img',
  ) as HTMLImageElement | null
  return img && img.src ? img.src : ""
}

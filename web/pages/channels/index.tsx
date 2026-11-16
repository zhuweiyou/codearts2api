import { useEffect, useState } from "react"

import { hostRpcCall } from "../../api/rpc"
import { getUpstreamPage } from "../../api/upstream"
import { ModelsPanelHost } from "./ModelsPanelHost"

function ChannelsView() {
  const [Page, setPage] = useState<React.ComponentType<any> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    try {
      setPage(() => getUpstreamPage())
    } catch (e: any) {
      setError(String(e?.message ?? e))
    }
  }, [])
  if (error) {
    return <pre className="c2a-boot-error">管理界面加载失败：{error}</pre>
  }
  if (!Page) return <div className="boot">正在加载管理界面…</div>
  return <Page rpcCall={hostRpcCall} />
}

export default function ChannelsPage() {
  return (
    <div className="c2a-view" id="admin-root" data-view="channels" role="tabpanel" aria-label="渠道管理">
      <ChannelsView />
      <ModelsPanelHost />
    </div>
  )
}

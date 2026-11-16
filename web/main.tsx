import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"

import App from "./App"
import { AuthGate } from "./components/AuthGate"
import { getUpstreamPage } from "./api/upstream"
import { installOAuthRelay } from "./utils/oauth-relay"
import "./App.less"
// 上游浏览器 bundle 作为 Vite 资产引入（?url）：构建时原样产出到 dist/assets 并返回 URL，
// 无需仓库 public/。它是 classic 脚本（首句调用 window.__ModuleLoader__.load），故用 <script> 注入。
import upstreamUrl from "dsh-providers-hub/client?url"

;(window as any).__ModuleLoader__ = {
  load: (row: any) => {
    ;(window as any).__JET_HUB_ROW__ = row
  },
}

// 尽早安装 OAuth 中继：改写 window.open 与页面上的 loopback 链接，远程部署时回调不再打不开。
installOAuthRelay()

function loadUpstream(): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script")
    s.src = upstreamUrl
    s.async = false
    s.onload = () => resolve()
    s.onerror = () => reject(new Error("上游 bundle 加载失败（dsh-providers-hub/client）"))
    document.head.appendChild(s)
  })
}

const el = document.getElementById("c2a-root")
if (!el) {
  console.error("[admin] 找不到 #c2a-root")
} else {
  loadUpstream()
    .then(() => {
      // 预装载上游页：触发 apply() 注入全局样式（dim-jh-modal* 等），供各视图弹窗复用。
      try {
        getUpstreamPage()
      } catch {
        /* 装载失败留给渠道视图报错 */
      }
      createRoot(el).render(
        <BrowserRouter basename="/admin">
          <AuthGate>
            <App />
          </AuthGate>
        </BrowserRouter>,
      )
    })
    .catch((err: any) => {
      const msg = String(err?.message ?? err).replace(
        /[&<>]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string,
      )
      el.innerHTML = '<pre class="c2a-boot-error">管理界面加载失败：' + msg + "</pre>"
    })
}

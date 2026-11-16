/**
 * /admin 外壳（React Router 显式路由，basename=/admin）。
 * 全局状态用 zustand（store/theme），横切逻辑抽成 hooks；路由表见 ./routes.tsx。
 */
import { Suspense, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate, useRoutes } from "react-router-dom"

import { routes } from "./routes"

import { useAdminAuthVisible } from "./hooks/useAdminAuthVisible"
import { useMeasureGutter } from "./hooks/useMeasureGutter"
import { OAuthRelayFix } from "./components/OAuthRelayFix"
import { logout } from "./api/auth"
import { THEMES, useThemeStore } from "./store/theme"

type ViewId = "overview" | "channels" | "callers"

const NAV: { id: ViewId; label: string; title: string }[] = [
  { id: "overview", label: "总览", title: "网关状态、今日用量、趋势、渠道余额、积分收支、模型分布、自动签到" },
  { id: "channels", label: "渠道管理", title: "各渠道账号、聚合路由、网关、备份与恢复" },
  { id: "callers", label: "调用方", title: "分组白名单、分发 Key、按 Key / 模型的用量与调用记录" },
]

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const routeEl = useRoutes(routes)
  const { theme, setTheme } = useThemeStore()
  const showLogout = useAdminAuthVisible()
  useMeasureGutter()

  const [menuOpen, setMenuOpen] = useState(false)
  const themeWrapRef = useRef<HTMLSpanElement | null>(null)

  const seg = location.pathname.replace(/^\//, "").split("/")[0]
  const view: ViewId = seg === "channels" || seg === "callers" ? (seg as ViewId) : "overview"

  useEffect(() => {
    document.documentElement.setAttribute("data-c2a-view", view)
    const label = NAV.find((n) => n.id === view)?.label
    document.title = (label ? label + " · " : "") + "codearts2api"
  }, [view])

  // 点外部关闭主题菜单
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (themeWrapRef.current && !themeWrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener("mousedown", onDown, true)
    return () => document.removeEventListener("mousedown", onDown, true)
  }, [menuOpen])

  const themeMeta = THEMES.find((t) => t.id === theme) ?? THEMES[0]

  return (
    <div className="c2a-app">
      <header className="c2a-topbar">
        <div className="c2a-topbar-inner">
          <a
            className="c2a-brand"
            href="/admin/overview"
            aria-label="codearts2api 总览"
            onClick={(e) => {
              e.preventDefault()
              navigate("/overview")
            }}
          >
            <span className="c2a-brand-mark" aria-hidden="true"></span>
            <span className="c2a-brand-text">codearts2api</span>
          </a>
          <nav className="c2a-nav" id="c2a-nav" role="tablist" aria-label="主导航">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className="c2a-nav-item"
                role="tab"
                data-nav={item.id}
                aria-controls={"c2a-view-" + item.id}
                aria-selected={view === item.id ? "true" : "false"}
                title={item.title}
                tabIndex={view === item.id ? 0 : -1}
                onClick={() => navigate("/" + item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="c2a-actions" id="c2a-actions">
            <OAuthRelayFix />
            <span ref={themeWrapRef} className="c2a-inline-flex">
              <button
                type="button"
                className="c2a-btn c2a-icon-btn"
                id="c2a-theme"
                aria-haspopup="menu"
                aria-expanded={menuOpen ? "true" : "false"}
                aria-label="切换主题"
                title={"主题：" + themeMeta.label}
                onClick={() => setMenuOpen((v) => !v)}
              >
                {themeMeta.icon}
              </button>
              {menuOpen ? (
                <div className="c2a-menu" role="menu">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="c2a-menu-item"
                      role="menuitemradio"
                      aria-checked={t.id === theme ? "true" : "false"}
                      onClick={() => {
                        setTheme(t.id)
                        setMenuOpen(false)
                      }}
                    >
                      {t.icon + "  " + t.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
            {showLogout ? (
              <button
                type="button"
                className="c2a-btn c2a-btn--ghost"
                id="c2a-logout"
                title="退出管理后台"
                onClick={async () => {
                  await logout()
                  window.location.assign("/admin/login")
                }}
              >
                退出
              </button>
            ) : null}
          </div>
        </div>
      </header>
      <main className="c2a-main">
        <Suspense fallback={<div className="c2a-suspense">加载中…</div>}>{routeEl}</Suspense>
      </main>
    </div>
  )
}

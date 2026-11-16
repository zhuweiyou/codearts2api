import { lazy } from "react"
import type { RouteObject } from "react-router-dom"
import { Navigate } from "react-router-dom"

/**
 * 显式路由表（不用 vite-plugin-pages）。
 * 页面组件按路由懒加载，各自成为独立 chunk。
 */
const OverviewPage = lazy(() => import("./pages/overview/index"))
const CallersPage = lazy(() => import("./pages/callers/index"))
const ChannelsPage = lazy(() => import("./pages/channels/index"))

export const routes: RouteObject[] = [
  { path: "/", element: <Navigate to="/overview" replace /> },
  { path: "/overview", element: <OverviewPage /> },
  { path: "/channels", element: <ChannelsPage /> },
  { path: "/callers", element: <CallersPage /> },
  { path: "*", element: <Navigate to="/overview" replace /> },
]

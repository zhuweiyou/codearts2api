import { Navigate } from "react-router-dom"
import type { RouteObject } from "react-router-dom"

// 目前页面很少：**同步 import**，不做按路由的 lazy 分包（少一次请求、无 Suspense 等待）。
// 未来页面变多时，把下面三行改成：
//   const OverviewPage = lazy(() => import("./pages/overview/index"))
// 即可按路由异步拆包（App 已包在 <Suspense> 里，无需其它改动）。
import CallersPage from "./pages/callers/index"
import ChannelsPage from "./pages/channels/index"
import OverviewPage from "./pages/overview/index"

export const routes: RouteObject[] = [
  { path: "/", element: <Navigate to="/overview" replace /> },
  { path: "/overview", element: <OverviewPage /> },
  { path: "/channels", element: <ChannelsPage /> },
  { path: "/callers", element: <CallersPage /> },
  { path: "*", element: <Navigate to="/overview" replace /> },
]

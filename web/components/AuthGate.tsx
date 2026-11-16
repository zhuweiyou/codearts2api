/** 鉴权门：先查会话；未登录在任意路由展示 <Login/>，已登录渲染后台。 */
import { useEffect, useState, type ReactNode } from "react"

import { getSession } from "../api/auth"
import { Login } from "./Login"

export function AuthGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    getSession().then((session) => {
      if (alive) setAuthenticated(session.authenticated)
    })
    return () => {
      alive = false
    }
  }, [])

  if (authenticated === null) return null
  if (!authenticated) {
    return <Login onSuccess={(next) => window.location.assign(next)} />
  }
  return <>{children}</>
}

import { create } from "zustand"

export type ThemeId = "auto" | "light" | "dark"

export const THEMES = [
  { id: "auto", label: "跟随系统", icon: "◐" },
  { id: "light", label: "浅色", icon: "☀" },
  { id: "dark", label: "深色", icon: "☾" },
] as const

const KEY = "c2a-theme"
const KEY_LEGACY = "c2-theme" // 旧 key，兼容改名前的已保存偏好

function readTheme(): ThemeId {
  try {
    const ls = window.localStorage
    let v = ls.getItem(KEY)
    if (v === null) {
      // 迁移旧 key：老用户已保存的主题不丢
      const old = ls.getItem(KEY_LEGACY)
      if (old === "light" || old === "dark") {
        ls.setItem(KEY, old)
        ls.removeItem(KEY_LEGACY)
        v = old
      }
    }
    return v === "light" || v === "dark" ? v : "auto"
  } catch {
    return "auto"
  }
}

export function applyTheme(theme: ThemeId) {
  const root = document.documentElement
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme)
  else root.removeAttribute("data-theme")
}

interface ThemeState {
  theme: ThemeId
  setTheme: (theme: ThemeId) => void
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: readTheme(),
  setTheme: (theme) => {
    try {
      const ls = window.localStorage
      if (theme === "auto") ls.removeItem(KEY)
      else ls.setItem(KEY, theme)
      ls.removeItem(KEY_LEGACY) // 写新 key 后清掉旧 key
    } catch {
      /* ignore */
    }
    applyTheme(theme)
    set({ theme })
  },
}))

// 启动即应用一次（避免首帧闪烁）。
applyTheme(readTheme())

import { create } from "zustand"

export type ThemeId = "auto" | "light" | "dark"

export const THEMES = [
  { id: "auto", label: "跟随系统", icon: "◐" },
  { id: "light", label: "浅色", icon: "☀" },
  { id: "dark", label: "深色", icon: "☾" },
] as const

const KEY = "c2-theme"

function readTheme(): ThemeId {
  try {
    const v = window.localStorage.getItem(KEY)
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
      if (theme === "auto") window.localStorage.removeItem(KEY)
      else window.localStorage.setItem(KEY, theme)
    } catch {
      /* ignore */
    }
    applyTheme(theme)
    set({ theme })
  },
}))

// 启动即应用一次（避免首帧闪烁）。
applyTheme(readTheme())

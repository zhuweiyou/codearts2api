/**
 * 装载上游浏览器 bundle（`dsh-providers-hub/client`）里的整页组件 `JetHubPage`。
 * 逻辑：先截留 `__ModuleLoader__.load({id,factory})` 的那一行，
 * 再用桩 ctx 调 `apply()`，从 slots 里捞整页组件。
 *
 * ⚠️ 上游 bundle 只 external 了 react / react-dom 与宿主 UI 原子库
 * （`@deepseek-ai/dsh-client-ui-primitives`，这里用最小替身顶上，理由见本文件说明）。
 */
import * as React from "react"
import { createPortal } from "react-dom"

import upstreamUrl from "dsh-providers-hub/client?url"

import { hostRpcCall } from "./rpc"

const UPSTREAM_UI_PRIMITIVES = "@deepseek-ai/dsh-client-ui-primitives"

/** 上游客户端 bundle 的单次加载（失败也缓存 Promise，避免并发重复注入脚本）。 */
let loadPromise: Promise<void> | null = null

export function loadUpstreamClient(): Promise<void> {
  if (loadPromise) return loadPromise
  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = upstreamUrl
    script.async = false
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("上游 bundle 加载失败（dsh-providers-hub/client）"))
    document.head.appendChild(script)
  })
  return loadPromise
}

function IconChevronDownOutlineRegular({ className, size = 14 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
      style={{ flex: "0 0 auto" }}
    >
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/* 上游 `Menu` 的最小替身（props 面：open/anchor/items/selectedId/onSelect/onClose/align/side/portal）。 */
function Menu({
  open,
  anchor,
  items = [],
  selectedId,
  onSelect,
  onClose,
  align = "start",
  side = "bottom",
  portal = false,
  className,
}: any) {
  const rootRef = React.useRef<HTMLSpanElement | null>(null)
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null)

  React.useLayoutEffect(() => {
    if (!open || !portal) {
      setPosition(null)
      return
    }
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const margin = 12
      const width = listRef.current?.offsetWidth ?? 0
      const height = listRef.current?.offsetHeight ?? 0
      const left = align === "end" ? rect.right - width : rect.left
      const top = side === "top" ? rect.top - height - 4 : rect.bottom + 4
      setPosition({
        left: Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - width - margin)),
        top: Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - height - margin)),
      })
    }
    place()
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [open, portal, align, side])

  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target)) return
      if (listRef.current?.contains(target)) return
      onClose?.()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose?.()
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open, onClose])

  const listStyle: React.CSSProperties = {
    minWidth: 140,
    padding: 4,
    margin: 0,
    borderRadius: 8,
    border: "1px solid rgba(0,0,0,.12)",
    background: "#fff",
    boxShadow: "0 8px 24px rgba(0,0,0,.16)",
    zIndex: 2147483000,
    ...(portal
      ? { position: "fixed", ...(position ?? { left: 0, top: 0, visibility: "hidden" }) }
      : {
          position: "absolute",
          top: side === "top" ? undefined : "calc(100% + 4px)",
          bottom: side === "top" ? "calc(100% + 4px)" : undefined,
          [align === "end" ? "right" : "left"]: 0,
        }),
  }

  const list = open ? (
    <div ref={listRef} role="menu" className={className} style={listStyle} onClick={(e) => e.stopPropagation()}>
      {items.map((item: any) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return
            onSelect?.(item.id)
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "6px 10px",
            border: 0,
            borderRadius: 6,
            background: item.id === selectedId ? "rgba(0,0,0,.06)" : "transparent",
            color: "inherit",
            font: "inherit",
            textAlign: "left",
            cursor: item.disabled ? "not-allowed" : "pointer",
          }}
        >
          <span style={{ flex: 1 }}>{item.label}</span>
          {item.id === selectedId ? <span aria-hidden="true">✓</span> : null}
        </button>
      ))}
    </div>
  ) : null

  return (
    <span ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      {anchor}
      {portal && list ? createPortal(list, document.body) : list}
    </span>
  )
}

/**
 * 从上游 bundle 行里取出 `JetHubPage`。任何一步失败都抛出可读错误（而不是白屏）。
 * 结果缓存（只装载一次）。
 */
function loadUpstreamPage(): React.ComponentType<any> {
  const captured: any = (globalThis as any).__JET_HUB_ROW__
  if (captured === null || typeof captured !== "object" || typeof captured.factory !== "function") {
    throw new Error(
      "上游 jet-hub 客户端 bundle 未先加载（上游 jet-hub 客户端 bundle（dist/assets/jet-hub-*.js）缺失或加载失败）",
    )
  }

  const upstream = captured.factory((name: string) => {
    if (name === "react") return React
    if (name === "react-dom") return { createPortal }
    if (name === UPSTREAM_UI_PRIMITIVES) return { Menu, IconChevronDownOutlineRegular }
    throw new Error(`上游 bundle 请求了未预期的模块：${name}`)
  })

  let mainPage: React.ComponentType<any> | null = null
  let settingsPage: React.ComponentType<any> | null = null

  upstream.apply({
    effect: (body: any) => body(),
    inject: (_deps: any, callback: any) => {
      callback({})
      return () => {}
    },
    modelDirectories: {
      directoryFor() {
        throw new Error("本宿主不提供 ctx.modelDirectories（/admin 不渲染会话槽位）")
      },
    },
    slots: {
      inject: (_name: any, callback: any) => callback(),
      register: (options: any, component: any) => {
        if (options?.name === "main") mainPage = component
        if (options?.name === "settings.section") settingsPage = component
        return () => {}
      },
    },
    connection: {
      rpc: {
        async call(_channel: any, _endpoint: any, request: any, signal: any) {
          return hostRpcCall(request?.method, request?.payload, signal)
        },
      },
    },
  })

  const page = mainPage ?? settingsPage
  if (page === null) throw new Error("上游未注册 main / settings.section，无法渲染管理界面")
  return page
}

let cached: React.ComponentType<any> | null = null
let cachedError: Error | null = null

/** 取上游整页组件（缓存）。 */
export function getUpstreamPage(): React.ComponentType<any> {
  if (cached) return cached
  if (cachedError) throw cachedError
  try {
    cached = loadUpstreamPage()
    return cached
  } catch (error: any) {
    cachedError = error
    throw error
  }
}

/**
 * 登录后才需要上游界面：先加载浏览器 bundle，再取整页组件。
 * 登录页不依赖它，避免上游资源故障时连登录框都出不来。
 */
export async function ensureUpstreamPage(): Promise<React.ComponentType<any>> {
  await loadUpstreamClient()
  return getUpstreamPage()
}

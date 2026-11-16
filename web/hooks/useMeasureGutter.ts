import { useEffect } from "react"

/** 量一次滚动条宽度写入 `--c2a-gutter`（布局对齐用），并在 resize 时重算。 */
export function useMeasureGutter() {
  useEffect(() => {
    const measure = () => {
      const supported = window.CSS && (CSS as any).supports && CSS.supports("scrollbar-gutter", "stable")
      let width = 0
      if (supported && document.body) {
        const probe = document.createElement("div")
        probe.style.cssText = "position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll"
        document.body.appendChild(probe)
        width = probe.offsetWidth - probe.clientWidth
        document.body.removeChild(probe)
      }
      document.documentElement.style.setProperty("--c2a-gutter", width + "px")
    }
    measure()
    let frame = 0
    const onResize = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
}

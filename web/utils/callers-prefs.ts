/**
 * 调用方视图的本地偏好（自动刷新开关）。
 * 新 key 优先；缺失时回退旧 key（改名前的 c2-rec-auto）并迁移，写入时清理旧 key。
 */
const AUTO_KEY = "c2a-rec-auto"
const AUTO_KEY_LEGACY = "c2-rec-auto"

export function readAutoOn(): boolean {
  try {
    const ls = window.localStorage
    let v = ls.getItem(AUTO_KEY)
    if (v === null) {
      // 迁移旧 key：老用户已保存的「自动刷新开关」不丢
      const old = ls.getItem(AUTO_KEY_LEGACY)
      if (old !== null) {
        ls.setItem(AUTO_KEY, old)
        ls.removeItem(AUTO_KEY_LEGACY)
        v = old
      }
    }
    return v !== "0"
  } catch {
    return true
  }
}

export function writeAutoOn(on: boolean): void {
  try {
    const ls = window.localStorage
    if (on) ls.removeItem(AUTO_KEY)
    else ls.setItem(AUTO_KEY, "0")
    ls.removeItem(AUTO_KEY_LEGACY)
  } catch {
    /* ignore */
  }
}

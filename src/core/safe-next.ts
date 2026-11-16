/** 收窄登录后跳转目标：只允许站内绝对路径，防开放重定向。 */
export function sanitizeNext(next: any): string {
  if (typeof next !== "string" || next === "") return "/admin/overview"
  if (!next.startsWith("/")) return "/admin/overview"
  if (next.startsWith("//") || next.startsWith("/\\")) return "/admin/overview"
  // 反斜杠 / 空白 / 控制字符会被浏览器归一化成 //host（开放重定向）
  for (const ch of next) {
    const code = ch.charCodeAt(0)
    if (ch === "\\" || code <= 0x1f || code === 0x7f || /\s/.test(ch)) return "/admin/overview"
  }
  return next
}

/** 收窄登录后跳转目标：只允许站内绝对路径，防开放重定向。 */
export function sanitizeNext(next: any): string {
  if (typeof next !== "string" || next === "") return "/admin/overview"
  if (!next.startsWith("/")) return "/admin/overview"
  if (next.startsWith("//") || next.startsWith("/\\")) return "/admin/overview"
  return next
}

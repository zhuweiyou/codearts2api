/**
 * 登录页：**不需要前端 JS** 的纯表单页。
 *
 * ## 为什么不做成「加载后台后弹密钥框」（参考仓库的做法）
 *
 * 那种形态下 `/admin` 的 HTML 与 `/admin.js` 必须先公开，否则弹框的脚本都下不来；
 * 于是任何人都能看到「这台机器跑着 codearts2api、后台长什么样」。本项目的
 * 页面里还嵌着上游完整的管理 UI（644KB），没必要白送。
 *
 * 用服务端渲染的独立登录页 + 会话 Cookie，就能把**导航请求本身**也拦住，
 * 且表单提交不依赖任何脚本 —— 顺手省掉「加密钥框」要处理的 XSS 面。
 *
 * ## 为什么没有「记住我」勾选框
 *
 * Cookie 本身就是 30 天有效期的会话（见 `admin-auth.js` 的 `SESSION_MAX_AGE`）。
 * 多一个勾选框只会让「默认不安全」成为可能。
 *
 * ## 样式为什么是内联 `<style>`
 *
 * 这一页没有构建步骤（不经过 esbuild），把几十行 CSS 拆成 `.css` 文件只为
 * 满足「零内联」的洁癖并不值得。CSP 因此允许 `style-src 'unsafe-inline'` ——
 * **样式不执行代码**，放宽它换来的是这个页面可以自包含。
 */

import { escapeHtml } from "./admin-auth.js"

/**
 * 渲染登录页。
 *
 * @param options - `{ error, next, disabled }`。
 *   `error` 非空时显示错误行；`next` 是登录成功后要跳回的站内路径。
 * @returns 完整 HTML 文档。
 */
export function renderLoginPage(options = {}) {
  const next = sanitizeNext(options.next)
  const error = typeof options.error === "string" && options.error !== "" ? options.error : null

  // ⚠️ 只保留「鉴权被关闭」这一条提示：它是用户必须知道的安全风险，且不含任何内情。
  //    密钥**位置**与**来源**一律不回显 —— 登录页是未认证页面，把服务器文件系统
  //    路径与部署形态（环境变量 vs 文件）写给任何访问者，等于替攻击者标好了下一步。
  const hint = options.disabled
    ? `<p class="hint warn">本实例的管理端鉴权已被 <code>CODEARTS2API_ADMIN_AUTH=0</code> 关闭，
        任何人打开此地址都可直接进入后台。仅当你确定只在本机/内网运行时才这样用。</p>`
    : ""

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>登录 · codearts2api</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        background: #f5f6f8;
        color: #1f2329;
      }
      .card {
        width: 100%;
        max-width: 420px;
        padding: 28px;
        border-radius: 12px;
        background: #fff;
        box-shadow: 0 8px 32px rgb(15 23 42 / 10%), 0 1px 2px rgb(15 23 42 / 6%);
      }
      h1 { display: flex; align-items: center; gap: 9px; margin: 0 0 4px; font-size: 18px; font-weight: 650; }
      .mark { width: 22px; height: 22px; border-radius: 7px; background: linear-gradient(135deg, #5b6ffb, #1677ff); }
      .sub { margin: 0 0 20px; color: #8f959e; font-size: 13px; }
      label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500; }
      input[type="password"] {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid #e5e6eb;
        border-radius: 8px;
        font: inherit;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      input[type="password"]:focus { outline: none; border-color: #1677ff; box-shadow: 0 0 0 3px rgb(22 119 255 / 16%); }
      button {
        width: 100%;
        margin-top: 16px;
        padding: 10px 12px;
        border: 0;
        border-radius: 8px;
        background: #1677ff;
        color: #fff;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      button:hover { background: #0f5fce; }
      .error {
        margin: 0 0 16px;
        padding: 10px 12px;
        border-radius: 8px;
        background: #ffebe9;
        border: 1px solid #ff818266;
        color: #a40e26;
        font-size: 13px;
      }
      .hint { margin: 18px 0 0; color: #656d76; font-size: 12px; line-height: 1.7; }
      .hint.warn { color: #9a6700; }
      code {
        padding: 1px 5px;
        border-radius: 4px;
        background: #eff1f3;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        word-break: break-all;
      }
      @media (prefers-color-scheme: dark) {
        body { background: #15171b; color: #e6e8eb; }
        .card { background: #23272d; box-shadow: 0 8px 32px rgb(0 0 0 / 40%); }
        .sub, .hint { color: #8b929d; }
        input[type="password"] { background: #1a1d22; border-color: #33373e; color: #e6e8eb; }
        input[type="password"]:focus { border-color: #4b8dff; box-shadow: 0 0 0 3px rgb(75 141 255 / 20%); }
        button { background: #4b8dff; }
        button:hover { background: #3b7cf0; }
        code { background: #2b3037; }
        .error { background: #3d1214; border-color: #f8514966; color: #ffa198; }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1><span class="mark" aria-hidden="true"></span>codearts2api</h1>
      <p class="sub">管理后台需要访问密钥</p>
      ${error === null ? "" : `<p class="error">${escapeHtml(error)}</p>`}
      <form method="post" action="/admin/login">
        <label for="key">访问密钥</label>
        <input
          id="key"
          name="key"
          type="password"
          autocomplete="current-password"
          spellcheck="false"
          ${options.disabled ? "" : "autofocus"}
          required
        />
        <input type="hidden" name="next" value="${escapeHtml(next)}" />
        <button type="submit">进入后台</button>
      </form>
      ${hint}
    </main>
  </body>
</html>`
}

/**
 * 收窄登录后跳转目标，**只允许站内绝对路径**。
 *
 * 不做这一步就是开放重定向：`/admin/login?next=https://evil.com` 会在登录成功后
 * 把用户甩到外部站点，而地址栏显示的还是「刚从这个站登录完」。
 *
 * 规则：以 `/` 开头、不以 `//` 或 `/\` 开头（后两者会被浏览器当作协议相对 URL）。
 *
 * @returns 安全的站内路径；非法值一律回落到 `/admin`。
 */
export function sanitizeNext(next) {
  if (typeof next !== "string" || next === "") return "/admin"
  if (!next.startsWith("/")) return "/admin"
  if (next.startsWith("//") || next.startsWith("/\\")) return "/admin"
  return next
}

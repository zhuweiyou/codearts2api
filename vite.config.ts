import { fileURLToPath } from "node:url"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vite-plus"

/**
 * Vite+（vp）配置 —— 前端自足在 `web/`，`vp build` 一次产出到仓库 `dist/`，不再依赖仓库 `public/`。
 *
 * 目录结构（web/ 即 Vite 根）：
 *   index.html          入口页（仅 #admin-root + module main.tsx）
 *   main.tsx            引导：内联 boot 垫片 + 动态加载上游 bundle + 挂 BrowserRouter
 *   App.tsx             外壳（顶栏/导航/主题/退出 + 路由出口）
 *   pages/*.tsx         文件路由（vite-plugin-pages，按页异步分块）
 *   components/**       视图组件（overview/callers…）
 *   api/**              RPC / 上游装载等
 *   store/**            zustand 全局状态
 *   hooks/**            自定义 hooks
 *   styles/**           CSS（admin/overview/callers…）
 *   assets 由 import / ?url 交给 Vite 产出（admin.css、上游 bundle）
 *
 * 部署：app 挂在 `/admin/`（base 与 BrowserRouter basename 一致），后端对 `/admin/*` 做 SPA 200 fallback。
 */
export default defineConfig({
  root: "web",
  base: "/admin/",
  // 不使用 web/public：静态资源全部 import / ?url 交给 Vite。
  publicDir: false,
  resolve: {
    alias: {
      // 从上游依赖直接取渠道元数据（零 import 的纯数据），避免手写中文名映射漂移。
      "dsh-providers-hub/provider-registry": fileURLToPath(
        new URL("./node_modules/dsh-providers-hub/lib/provider-registry.js", import.meta.url),
      ),
    },
  },
  // 路由为显式声明（web/routes.tsx），不用文件路由插件。
  plugins: [react()],
  server: {
    // dev：仅把这些后端接口反代到 127.0.0.1:8080；其余路径走 SPA 回退到 index.html。
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/healthz": "http://127.0.0.1:8080",
      "/v1": "http://127.0.0.1:8080",
      "/admin/logout": "http://127.0.0.1:8080",
      "/admin/callers/api": "http://127.0.0.1:8080",
      "/admin/dashboard/api": "http://127.0.0.1:8080",
      "/admin/models/api": "http://127.0.0.1:8080",
      // 回调修复：重放接口 + 中继（/relay/<port>/...）
      "/admin/oauth-relay": "http://127.0.0.1:8080",
      "/relay": "http://127.0.0.1:8080",
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // CSP script-src 'self'：不要生成内联的 modulepreload polyfill。
    modulePreload: { polyfill: false },
  },
  // 格式化：双引号 / 无分号 / 120 宽（与仓库既有 .prettierrc 对齐）。忽略产物/依赖/旧文件。
  fmt: {
    singleQuote: false,
    semi: false,
    printWidth: 120,
    tabWidth: 2,
    useTabs: false,
    ignorePatterns: [
      "dist/**",
      "dist-server/**",
      "node_modules/**",
      "coverage/**",
      "data/**",
      "attachments/**",
      // 文档/配置/脚本不参与代码格式化：
      "**/*.md",
      "**/*.yml",
      "**/*.yaml",
      "**/*.json",
      ".github/**",
      "docs/**",
      "scripts/**",
    ],
  },
  // Lint（Oxlint）：忽略产物/依赖；src 后端与新前端都在检查范围内。
  // Lint（Oxlint，非类型感知）：只做语法/风格规则；类型检查交给独立的 `pnpm run typecheck`（tsc，覆盖 web）。
  lint: {
    ignorePatterns: ["dist/**", "dist-server/**", "node_modules/**", "coverage/**", "data/**", "attachments/**"],
  },
  // 测试统一用 Vitest（vp test）。tests 在仓库根，用 ../tests 从 web 根指过去。
  test: {
    environment: "node",
    include: ["../tests/**/*.test.{ts,tsx}"],
    // Windows / 并行下 app.close() 与部分用例可能超过默认超时（hook 10s / test 5s）
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
})

# 迁移到 Vite+（vp）可行性 / 复杂度评估

> 分支：`refactor/vite-plus-migration-assessment`（基于 `main` @ `541a121`，未提交）
> 目的：评估把本项目迁移到 Vite+（Vite / Rolldown + Vitest + Oxlint + Oxfmt + tsdown + Vite Task，统一 `vp` CLI）的复杂度与落地路径。
> 说明：以下结论来自「官方迁移规则通读 + 本仓库代码盘点」，**尚未在本仓库真正执行 `vp migrate`**（它会改写 manifest / lockfile）。凡标 ⚠️ 的点都需要在隔离分支上真跑一遍验证。

---

## 0. 一句话结论

- **只做「Vite+ 构建 + lint/fmt」：低复杂度，约 1~2 天可落地（保留 JS）。**
- **再加「React + TS/TSX」：中低，主要成本在入口 `web/admin.jsx` 的 TS 化与 `vp check` 类型检查，约再加 1~2 天。**
- **把整个后端 7764 行 JS 转 TS、把 4200+ 行运行时 DOM 脚本改成 React 组件：高复杂度（数周级），且是「重写」而非「迁移」，建议单列、不要和本轮混做。**
- **关键判断**：Vite+ 是**面向 Web 的**工具链，**不构建、不运行 Node 后端**。当前真正被 esbuild 构建的只有 `web/admin.jsx` 一个入口；其余「前端」其实是**服务端运行时下发的字符串脚本 / 静态文件**，Vite 根本不参与。所以「构建迁移」的面很小，复杂度大头在「TS/TSX 化」和「工具链替换带来的全仓格式/规则对齐」。
- **但**：若改为**前后端分离**、把 admin 做成**标准 Vite 前端应用**，则 `vp dev`(带 HMR 前端) / `vp build`(前端) / `vp pack`(Node 后端) / `vp run`(一键串联) 都能真正用起来——**代价是把现有 admin 改造成 Vite 应用的中大型前端重构**，详见 §8。

---

## 1. 目标栈是什么（Vite+）

VoidZero 的 **Vite+**（`vp`），一个包统合：Vite 8 + Rolldown（构建）、Vitest（测试）、Oxlint（lint）、Oxfmt（格式化）、tsdown（库/可执行打包）、Vite Task（任务编排），并提供 `vp migrate` 把现有 Vite/Vitest/ESLint/Prettier/tsdown/tsx 等设置一次性收编。
核心命令：`vp dev` / `vp build` / `vp check`（格式+lint+类型检查一把过）/ `vp test` / `vp pack` / `vp run`。
- 参考：<https://viteplus.dev/guide/why>、<https://viteplus.dev/guide/migrate>、<https://viteplus.dev/guide/migrate-rules>、<https://viteplus.dev/guide/build>

---

## 2. 现状盘点（决定复杂度的基数）

| 层 | 现状 | 规模 |
|---|---|---|
| 后端运行时 | Node ESM **纯 JS**（`src/*.js`） | 16 文件 / **7764 行** |
| 测试 | `node --test` + jsdom + 真实 HTTP 服务器 | 12 文件 / **2855 行** |
| React 入口（唯一被构建的东西） | `web/admin.jsx` → esbuild 打成 **IIFE** `public/admin.js`（自带 React 运行时），入口读 `globalThis.__JET_HUB_ROW__` 装载上游 bundle | **361 行** |
| 上游浏览器产物 | `dsh-providers-hub/client`，**原样拷贝**成 `public/upstream-jet-hub.js`（只 external react/react-dom） | 1.06MB（不重打包） |
| 手写静态浏览器脚本 | `public/admin-shell.js`（外壳/路由/主题）、`public/admin-boot.js`（模块加载器 shim） | 440 行 |
| 服务端下发的 UI 脚本 | `callers-ui.js` / `dashboard-admin.js` / `caller-admin.js` / `models-admin.js` 里各有一段 `UI_SRC = String.raw\`…\`` —— **浏览器原生 DOM 代码，作为字符串在运行时吐出**（不是构建产物、不是 React） | 1440+1179+943+671 ≈ **4233 行** |
| 构建 | `build.mjs`（esbuild 单入口 IIFE + 拷贝上游 bundle） | 70 行 |
| Lint / Format | ESLint flat config + Prettier（`semi:false` / `printWidth:120` / `endOfLine:auto`） | — |
| 外壳 HTML | `public/admin.html` 手写，服务端配 **CSP `script-src 'self'`**，页面只加载三个同源脚本（`admin-boot.js` / `upstream-jet-hub.js` / `admin.js`） | — |
| 包管理 / 运行时 | pnpm **11.25 钉版**（corepack `prepare --activate`）；`package.json` **刻意不写 `packageManager`**；上游是 git 依赖、自带 pnpm-lock；DSH 基础包要求**整族精确同版本**；`PNPM_CONFIG_MINIMUM_RELEASE_AGE=0` 不能删 | — |

现有 `dependency` 面很薄（cordis + 几个 dsh-* + upstream），devDeps 只有 eslint/esbuild/prettier/react/jsdom/globals。**没有** tsconfig / vite / vitest / typescript。

---

## 3. 分块复杂度评估

> 复杂度：🟢 低 / 🟡 中 / 🔴 高　｜　人日为粗估（含自测回归）

### A. 构建：esbuild → `vp build`（Vite/Rolldown）　🟢 低
- 只替换 **`web/admin.jsx` 这一个入口**的打包。用 Vite 的 **lib 模式**（`build.lib` + `formats:['iife']`，或 rollupOptions 单文件）产出**单个** `public/admin.js`。
- 必须保住现有语义：`define: process.env.NODE_ENV='"production"'`、`charset:'utf8'`（中文不转义）、**单文件、无 code-splitting、固定文件名**（服务端路由是死的 `/admin.js`，且 CSP 不允许 inline 脚本）。
- 上游 bundle **继续由脚本拷贝、不进 Vite**（保持现状，别让 `vp build` 去处理它）。
- 成本：约 **0.5~1 天**。风险集中在「lib 模式产出与现 IIFE 产物是否等价、CSP/路由是否仍匹配」。

### B. Lint / Format：ESLint+Prettier → Oxlint+Oxfmt　🟢~🟡 低-中
- 用 `vite.config.ts` 里的 `lint` / `format` 段复刻现有配置：忽略产物（`public/admin.js`、`public/upstream-jet-hub.js`、`data/`、`attachments/`…）、`src`/`tests` 用 Node globals、`web`/`public` 用 browser globals、`semi:false`、`printWidth:120`。
- **Oxfmt 会重排整个仓库**（一次性大 diff）；`endOfLine` 默认与现 `auto` 不同，小心 CRLF 陷阱（本项目历史上就踩过）。
- Oxlint 规则与 ESLint `recommended` 不是逐条等价，需逐项核；`UI_SRC` 字符串内的代码本就**不被 lint**（现状也一样）。
- 成本：**1~2 天** + 一次全仓格式化评审。

### C. React + TS/TSX（仅入口）　🟡 中低
- `web/admin.jsx` → `web/admin.tsx`，补类型（`captured.factory`、桩 `ctx`、RPC 信封等），加 `tsconfig.json`，用 `vp check` 做类型检查。
- 后端 JS 可先 `allowJs` / 仅对前端做类型检查，不强求全量 TS。
- 成本：**1~2 天**。

### D. 后端 TS 化（`src/*.js` 7764 行）　🔴 高
- 要改运行方式：从 `node src/index.js` 改成 `vpx src/index.ts`（`vite-plus/register`）或先 build 再跑；全量补类型；涉及 cordis 插件生命周期、上游类型、`AbortSignal`/fetch 等。
- 收益（纯 Node 后端用不到 Vite 的浏览器能力）与风险不成正比。**建议单列阶段，甚至不做**。成本：**1~3 周**。

### E. `UI_SRC` 原生 DOM 脚本 → React/TSX　🔴 高（≈重写）
- 这 4 段是**服务端模板字符串下发的浏览器原生脚本**（4233 行），不是构建产物、不是 React。改成 React 组件等于**重写**，并改变架构（谁来挂载、CSP、与上游页共存）。
- **不建议纳入本轮**。若只想「能上 TS 语法」，也要把字符串拆成独立 `.ts` 源再在构建期内联，成本仍大。

### F. 测试：`node --test` → Vitest（要 `vp test` 才需要）　🟡 中
- 12 文件 2855 行，`node:test` 的 `test()` 断言 + jsdom + 真实 HTTP 服务器，迁到 Vitest 的 `describe/it/expect`；并发/超时/端口占用语义不同（本项目测试已出现过端口争用型 flaky）。
- 若短期不追求 `vp test`，**可先保留 `node --test`**（但注意 `vp test` 跑的是 Vitest，不会跑它们）。成本：**2~4 天**。

### G. 包管理 / 运行时 / CI / Docker　🟡 中
- `vp migrate` 会加 `vite-plus` 到 devDeps，并加 **vite→`@voidzero-dev/vite-plus-core` 别名 override、vitest 精确 pin**。
- ⚠️ **与本项目「DSH 基础包整族同版本 + 上游 git 依赖自带 lock + pnpm 11.25 钉版」要实测不冲突**：overrides 可能扰动 lockfile，进而影响上游 `prepare`。必须在隔离分支 `vp install` 后跑 `pnpm test` 全绿 + 启动时「上游契约核对通过」再算数。
- Dockerfile / CI 的 `pnpm run build` → `vp build`；保留 `PNPM_CONFIG_MINIMUM_RELEASE_AGE=0`；Node 版本已满足 Vite+ 要求（`^22.18 || ^24.11 || >=26`，本机 24.18）。
- `public/admin.html` 手写外壳 + CSP 不变（Vite 不管这个 HTML）。成本：**1~2 天 + 回归**。

---

## 4. 复杂度总览

| 阶段 | 内容 | 复杂度 | 粗估 |
|---|---|---|---|
| P0 | 只换工具链：`vp build`(lib/iife) + `vp check`(Oxlint/Oxfmt)，保留 JS 与 node:test | 🟢~🟡 | 0.5~1.5 天 |
| P1 | 入口 `web/admin.jsx` → `admin.tsx` + `tsconfig` + `vp check` 类型检查 | 🟡 | 1~2 天 |
| P2 | 测试迁 Vitest（想要 `vp test` 才做） | 🟡 | 2~4 天 |
| P3 | 后端 7764 行 TS 化 / UI_SRC 4200 行组件化 | 🔴 | 1~3 周+（≈重写） |

**最小可用（实现“迁移到 viteplus 那套构建和 lint/fmt”）= P0**；**再加 “react+ts+tsx” = P0+P1**。P2/P3 按需、单列。

---

## 5. 关键风险与坑

1. ⚠️ **依赖图冲突**：Vite+ 注入 `vite` 别名 override + vitest pin，可能扰动上游 git 依赖的 lock 与「DSH 同族精确同版本」约束 → 必须先隔离验证 `pnpm test` 与启动契约。
2. ⚠️ **CSP 与固定路由**：`script-src 'self'` + 死路由 `/admin.js` ⇒ Vite 产物必须**单文件、IIFE、无 inline、无 hash 文件名**；`vp dev`（注入 inline + `/@vite/client`）在本站点**默认不可用**。
3. ⚠️ **`vp dev` 是否适用取决于架构**：若沿用「Node 直接下发 admin.html + 运行时字符串脚本」，Vite dev server 与后端 + 上游 classic 脚本加载顺序 + CSP 组合复杂 → 只能取 `vp build` / `vp check`，拿不到 HMR；**若前后端分离、admin 变成标准 Vite 应用**，则 `vp dev` 就是带 HMR 的前端 dev server（见 §8）。
4. ⚠️ **Oxfmt 全仓重排**：一次性巨大 diff + `endOfLine`/CRLF 陷阱，评审与 `git blame` 成本高。
5. **上游 bundle 必须继续原样拷贝**，别被 Vite 收进依赖图。
6. **测试并发语义**：现有 `node --test` 已有端口争用型 flaky，迁移到 Vitest 并发模型不同，需重新盯稳定性。

---

## 6. 建议路线

1. **先 P0（隔离分支）**：装 `vite-plus`，`vp build` 用 lib/iife 产出等价 `public/admin.js`，`vp check` 替换 eslint+prettier；保留 JS、保留 `node --test`。验收：`vp build` 产物可被现 `admin.html` 加载、站点可视验、`pnpm test` 仍全绿、启动「上游契约核对通过」。
2. **再 P1**：入口 TSX 化 + `tsconfig` + 类型检查。
3. **P2/P3 单列**，尤其 P3（后端 TS / UI 组件化）应作为独立大型重构立项，不与工具链迁移混做。

---

## 7. 待验证（下一步可直接做）

- [ ] 在隔离分支跑 `pnpm dlx vite-plus@<版本> vp migrate --no-interactive`，看真实 manifest/lock 变更与 REVIEW/BLOCK 报告。
- [ ] 试 `vp build` lib/iife 单文件能否满足：单文件、无 inline、`utf8`、`NODE_ENV` 产出 React 生产版。
- [ ] `vp install` 后 `pnpm test` + 启动契约核对是否仍通过（验证依赖图未被 overrides 破坏）。
- [ ] Oxlint 规则集与现 ESLint `recommended` 的等价性核查清单。

---

## 8. 补充：前后端分离路线（vp dev / vp build / vp pack / vp run）

前提：把 `/admin` 从「Node 直接下发 admin.html + 运行时字符串脚本」改造成**标准 Vite 前端应用**（`index.html` + 模块图 + TS/TSX）。则工具链各归其位：

| 用途 | 命令 | 说明 |
|---|---|---|
| 前端开发（HMR） | **`vp dev`** | 标准 Vite dev server；后端另起，dev 用 `server.proxy` 把 `/api/jet-hub`、`/healthz`、`/v1/*` 反代到后端端口，绕开 CORS |
| 前端生产构建 | **`vp build`** | Vite，浏览器环境 |
| 后端构建 | **`vp pack`** | tsdown：ESM/CJS、dts、sourcemap、可选 SEA 可执行文件（SEA 需 Node ≥ 25.7） |
| 一键前后端构建 | **`vp run build`** | Vite Task 编排多条任务，各带缓存 |

**「一条命令前后端都 build」= `vp run` 编排，不是 `vp build` 单命令包前后端：**

```jsonc
// vite.config.ts
run: {
  tasks: {
    "build:web":    { command: "vp build" },   // 前端
    "build:server": { command: "vp pack" },    // 后端（Node / tsdown）
    "build":        { command: "vp run build:web && vp run build:server" },
  },
},
```
`vp run build` 会顺序/并行执行两条、各带缓存。`package.json` 写 `"build": "vp run build:web && vp run build:server"` 亦可。

**单命令多环境（可选，⚠️ 需实测）**：Vite 8 的 **Environment API** 可在一次 `vp build` 里同时 build client 与 ssr/node 环境；但产出是 **SSR bundle**，对「纯 Node 常驻服务 + `sharp` 原生依赖 + 上游 git 依赖」不理想，稳妥仍用 `vp pack` / `vpx` 跑 TS。

**分离路线的真实成本（比 §3 上升，主要是前端重构而非工具链）：**
- 上游 classic bundle（`__JET_HUB_ROW__` 全局 + `__ModuleLoader__.load` 拦截）：仍需在 index.html 里以 classic `<script>` 预加载再被入口捕获（可保留），但要纳入 Vite 入口页。
- 4 段 `UI_SRC`（4233 行原生 DOM，作为字符串下发）：要么继续运行时注入脚本，要么真迁成模块——后者是**重写**。
- `admin-shell.js` / `admin-boot.js`（手写 classic）：并入模块图 或 留 `public/` 由 index.html 引入。
- CSP：dev 下 Vite 需放宽（inline / `connect-src` ws）；生产若仍由 Node 托管 `dist/`，需继续满足 `script-src 'self'` 并处理 asset 路径。
- 生产托管：后端继续 serve `dist/`（改路由）或独立静态托管 + CORS。
- 后端 TS 化仍可选：`vpx src/index.ts` 直跑，或 `vp pack` 出 `dist/` 再 `node dist/index.js`。

**结论**：分离路线能让 `vp dev`/HMR 真正落地，`vp build` 管前端、`vp pack` 管后端、`vp run` 一键；但把现有 admin 改成 Vite 应用是本轮真正的大活（中大型前端重构），远贵于“纯换工具链”。

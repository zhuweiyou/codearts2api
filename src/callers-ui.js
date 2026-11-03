/**
 * 调用方管理 · 弹窗版 UI（注入到 /admin 的原生 header）。
 *
 * ## 为什么要单独一个文件
 *
 * `caller-admin.js` 已经带了后端（分组/Key 的增删改查、用量聚合、调用记录）。
 * 但它自己那一页 `/admin/callers` 是个独立 URL —— 用户的明确要求是「不要独立 URL，
 * 全并到 /admin，样式和原生一样」。所以本文件只做**前端壳**：
 *
 *   1. 往 `.dim-jh-headerActions` 插一个「调用方」按钮（与原生「网关」「Token 用量」并列）；
 *   2. 点开是原生 .dim-jh-modal 骨架，里面四个页签：
 *      **分组 / Key / 用量 / 调用记录**；
 *   3. 全部数据走 `caller-admin.js` 已有的 ``/admin/callers/api``，
 *      前端一行新增后端逻辑都没有 —— 避免出现「两套口径」。
 *
 * ## 与 caller-link.js 的关系
 *
 * 旧的 `caller-link.js` 插的是一个 `<a href="/admin/callers">` 链接（跳走）。
 * 本文件插的是 `<button>`（原地弹窗）。两者都挂着会导致 header 里出现两个入口，
 * 所以集成时必须把旧链接那条注入一起摘掉（只保留这里的 `<button>`）。
 *
 * ## 样式：自带一整套 Element Plus 皮肤（不依赖看板的 c2d 样式）
 *
 * 2026-11-02 用户反馈「调用方改成 table 表格，使用 element 主题风格」。
 * 之前这里只写了 `.c2m-*`，指望 `dashboard-admin.js` 的 ensureStyle 把 `.c2d-tbl`
 * 一并注入 —— 但那份样式只在看板弹窗打开时注入，于是调用方弹窗里的 `<table>`
 * 直接吃浏览器默认样式：表头变成居中加粗大字、无边框、无行分隔（截图实锤）。
 * 所以现在本文件自己注入**全部**类（`.c2d-tbl` / `.c2d-section` / `.c2d-empty`
 * 这些同名类也在内），并按 Element Plus 的设计令牌重写数值：
 * 表头 #f5f7fa 底 + #909399 字、行分隔 #ebeef5、hover #f5f7fa、
 * 主色 #409eff、成功 #67c23a、危险 #f56c6c、次要文字 #909399。
 * 统一用 `.c2m-scope` 作用域前缀，避免和看板自己的样式打架/互相污染。
 */

export const UI_PATH = "/admin/callers-ui.js"

export const UI_SRC = String.raw`
(function () {
  "use strict";

  var API = "/admin/callers/api";
  var MOUNTED_ATTR = "data-c2m-btn";
  var STYLE_ID = "c2m-style";

  /* ── 小工具（与看板保持同名的给同名，读代码时不串）────────────── */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(n) {
    var v = Number(n);
    if (!isFinite(v)) return "—";
    return Math.round(v).toLocaleString("zh-CN");
  }
  function fmtTokens(n) {
    var v = Number(n) || 0;
    if (v >= 1e8) return (v / 1e8).toFixed(2) + " 亿";
    if (v >= 1e4) return (v / 1e4).toFixed(1) + " 万";
    return fmt(v);
  }
  function ago(iso) {
    if (!iso) return "—";
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return "—";
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + " 秒前";
    if (s < 3600) return Math.round(s / 60) + " 分钟前";
    if (s < 86400) return Math.round(s / 3600) + " 小时前";
    return Math.round(s / 86400) + " 天前";
  }
  function hhmmss(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return "—";
    function p(n) { return String(n).padStart(2, "0"); }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  /* ── 日期选择器（下拉多选，替换原生 select multiple）──────────────
     原生的 <select multiple size=3> 有两个硬伤：多选必须按 Ctrl 点
     （点第二个就把第一个丢掉），且固定占三行高把筛选行撑得很高。
     这里改成 Element 风格的下拉：一排预设 + 勾选列表，点一下就是
     切换，不要求修饰键。 */
  var WD_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function wd(day) {
    var d = new Date(String(day) + "T00:00:00+08:00");
    return isFinite(d.getTime()) ? WD_NAMES[d.getDay()] : "";
  }

  function daysText(picked) {
    var list = (picked || []).slice().sort().reverse();
    if (list.length === 0) return "未选择 · 默认今天";
    if (list.length === 1) {
      var w = wd(list[0]);
      return list[0] + (w ? " " + w : "");
    }
    return "已选 " + list.length + " 天 · " + list[list.length - 1] + " → " + list[0];
  }

  /* 预设返回的日期集合；avail 是服务端给的有日志日期（已倒序）。 */
  function presetSet(kind, avail) {
    var all = (avail || []).slice();
    if (kind === "latest") return all.slice(0, 1);
    if (kind === "yesterday") return all.slice(1, 2);
    if (kind === "3") return all.slice(0, 3);
    if (kind === "7") return all.slice(0, 7);
    if (kind === "all") return all;
    if (kind === "none") return [];
    return null;
  }

  function sameSet(a, b) {
    return (a || []).slice().sort().join(",") === (b || []).slice().sort().join(",");
  }

  function availDaysNow() {
    return (state.records && state.records.availableDays) || [];
  }

  function presetMatches(kind) {
    var s = presetSet(kind, availDaysNow());
    return s !== null && sameSet(s, state.days || []);
  }

  function toggleDay(day) {
    var arr = (state.days || []).slice();
    var i = arr.indexOf(day);
    if (i >= 0) arr.splice(i, 1); else arr.push(day);
    /* 倒序保存，和 availableDays 一致，界面与请求参数都稳定。 */
    state.days = arr.sort().reverse().slice(0, 31);
    syncDaysUi();
  }

  function applyPreset(kind) {
    var s = presetSet(kind, availDaysNow());
    if (s === null) return;
    state.days = s.slice(0, 31).sort().reverse();
    syncDaysUi();
  }

  /* 只重画下拉自身，不整块 repaint：整块重画会丢掉列表滚动位置。 */
  function syncDaysUi() {
    if (!overlay) return;
    var dd = overlay.querySelector(".c2m-dd");
    if (!dd) return;
    dd.setAttribute("data-open", state.daysOpen ? "1" : "0");
    var panel = dd.querySelector("[data-c2m-ddpanel]");
    if (panel) {
      if (state.daysOpen) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    }
    var lb = dd.querySelector("[data-c2m-dayslabel]");
    if (lb) lb.textContent = daysText(state.days);
    Array.prototype.forEach.call(dd.querySelectorAll("[data-day]"), function (row) {
      if ((state.days || []).indexOf(row.getAttribute("data-day")) >= 0) row.classList.add("on");
      else row.classList.remove("on");
    });
    Array.prototype.forEach.call(dd.querySelectorAll("[data-preset]"), function (b) {
      if (presetMatches(b.getAttribute("data-preset"))) b.classList.add("on");
      else b.classList.remove("on");
    });
  }

  /* 返回值 true = 这次点击被日期控件吞掉，不再走后面的按钮分派。 */
  function handleDaysClick(e) {
    if (!overlay || state.tab !== "records") return false;
    var t = e.target;
    if (t.closest && t.closest('[data-act="days-toggle"]')) {
      state.daysOpen = !state.daysOpen;
      syncDaysUi();
      e.preventDefault();
      return true;
    }
    if (t.closest && t.closest("[data-c2m-ddpanel]")) {
      var row = t.closest("[data-day]");
      if (row) { toggleDay(row.getAttribute("data-day")); e.preventDefault(); return true; }
      var pre = t.closest("[data-preset]");
      if (pre) { applyPreset(pre.getAttribute("data-preset")); e.preventDefault(); return true; }
      return true;
    }
    /* 点面板外面就等于收起，但不吞这一次点击——它该继续去按「查询」。 */
    if (state.daysOpen) {
      state.daysOpen = false;
      syncDaysUi();
    }
    return false;
  }

  /* ── 样式（只补看板里没有的那几条）──────────────────────────────── */

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement("style");
    st.id = STYLE_ID;
    /* Element Plus 令牌（取自 element-plus/theme-chalk 的 CSS 变量默认值）：
       primary #409eff / success #67c23a / danger #f56c6c / warning #e6a23c
       text-primary #303133 / regular #606266 / secondary #909399 / placeholder #a8abb2
       border #dcdfe6 / light #e4e7ed / lighter #ebeef5 / fill #f5f7fa */
    st.textContent = [
      /* ── 作用域：一切样式只作用于调用方弹窗内部，不污染 /admin 其它区域 ── */
      /* ── 表格（Element Table 外观）────────────────────────────────── */
      ".c2m-scope .c2d-tbl{width:100%;border-collapse:collapse;table-layout:auto;font-size:13px;color:#606266;background:#fff;border-radius:4px}",
      ".c2m-scope .c2d-tbl th{background:#f5f7fa;color:#909399;font-weight:700;font-size:13px;text-align:left;padding:8px 12px;border-bottom:1px solid #ebeef5;white-space:nowrap}",
      ".c2m-scope .c2d-tbl td{text-align:left;padding:8px 12px;border-bottom:1px solid #ebeef5;color:#606266;font-size:13px;vertical-align:middle;line-height:1.5}",
      ".c2m-scope .c2d-tbl tbody tr:hover > td{background:#f5f7fa}",
      ".c2m-scope .c2d-tbl tr:last-child > td{border-bottom:0}",
      ".c2m-scope .c2d-tbl .num{text-align:right;font-variant-numeric:tabular-nums}",
      /* 固定列宽的表：溢出省略，避免长模型名把操作列挤成两行 */
      ".c2m-scope .c2d-tbl-fixed{table-layout:fixed}",
      ".c2m-scope .c2d-tbl-fixed td,.c2m-scope .c2d-tbl-fixed th{overflow:hidden;text-overflow:ellipsis}",
      /* ── 区块 / 空态 / 次要文字（原先靠看板注入，弹窗单独打开时就缺失）── */
      ".c2m-scope .c2d-section{margin-bottom:4px}",
      ".c2m-scope .c2d-sectionTitle{font-size:13px;font-weight:600;color:#303133;margin:0 0 10px}",
      ".c2m-scope .c2d-muted{color:#909399}",
      ".c2m-scope .c2d-empty{padding:28px 12px;text-align:center;color:#909399;font-size:13px}",
      /* ── 页签（Element Tabs：底部 2px 主色条）────────────────────────── */
      ".c2m-scope .c2m-tabs{display:flex;gap:2px;border-bottom:1px solid #e4e7ed;margin:0 0 14px}",
      ".c2m-scope .c2m-tab{appearance:none;border:0;background:none;padding:0 18px 9px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;color:#303133;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .15s}",
      ".c2m-scope .c2m-tab:hover{color:#409eff}",
      ".c2m-scope .c2m-tab.on{color:#409eff;border-bottom-color:#409eff;font-weight:600}",
      ".c2m-scope .c2m-tab .n{font-size:11px;color:#909399;margin-left:5px;font-weight:400}",
      /* ── 筛选行 ─────────────────────────────────────────────────────── */
      ".c2m-scope .c2m-filters{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin:0 0 12px;padding:12px 14px;border:1px solid #ebeef5;border-radius:6px;background:#fafafa}",
      ".c2m-scope .c2m-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".c2m-scope .c2m-field label{font-size:12px;color:#606266;line-height:16px}",
      ".c2m-scope .c2m-field select,.c2m-scope .c2m-field input{box-sizing:border-box;height:28px;border:1px solid #dcdfe6;border-radius:4px;padding:0 8px;font:inherit;font-size:12px;background:#fff;color:#606266;outline:none;transition:border-color .15s}",
      ".c2m-scope .c2m-field select:hover,.c2m-scope .c2m-field input:hover{border-color:#c0c4cc}",
      ".c2m-scope .c2m-field select:focus,.c2m-scope .c2m-field input:focus{border-color:#409eff}",
      ".c2m-scope .c2m-field-days{position:relative}",
      /* ── 日期下拉（Element Select 风格）────────────────────────────────
         原生 select multiple 要求按 Ctrl 才能多选、且固定三行高，
         换成「按钮 + 浮层面板」，点一下即切换。 */
      ".c2m-scope .c2m-dd{position:relative;display:inline-block}",
      ".c2m-scope .c2m-ddbtn{box-sizing:border-box;height:28px;min-width:196px;max-width:260px;display:inline-flex;align-items:center;gap:6px;justify-content:space-between;border:1px solid #dcdfe6;border-radius:4px;padding:0 8px;font:inherit;font-size:12px;background:#fff;color:#606266;cursor:pointer;text-align:left;transition:border-color .15s}",
      ".c2m-scope .c2m-ddbtn:hover{border-color:#c0c4cc}",
      ".c2m-scope .c2m-dd[data-open='1'] .c2m-ddbtn{border-color:#409eff}",
      ".c2m-scope .c2m-ddbtn>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".c2m-scope .c2m-ddarrow{flex:0 0 auto;color:#a8abb2;font-size:10px}",
      ".c2m-scope .c2m-ddpanel{position:absolute;z-index:20;top:calc(100% + 4px);left:0;width:252px;background:#fff;border:1px solid #e4e7ed;border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.1);padding:8px}",
      ".c2m-scope .c2m-ddpanel[hidden]{display:none}",
      ".c2m-scope .c2m-ddpre{display:flex;gap:6px;flex-wrap:wrap;padding-bottom:8px;margin-bottom:6px;border-bottom:1px solid #ebeef5}",
      ".c2m-scope .c2m-preset{appearance:none;border:1px solid #dcdfe6;background:#fff;color:#606266;border-radius:4px;font:inherit;font-size:11.5px;line-height:20px;padding:0 8px;cursor:pointer;transition:all .15s}",
      ".c2m-scope .c2m-preset:hover{color:#409eff;border-color:#c6e2ff;background:#ecf5ff}",
      ".c2m-scope .c2m-preset.on{color:#fff;background:#409eff;border-color:#409eff}",
      ".c2m-scope .c2m-ddlist{max-height:196px;overflow:auto}",
      ".c2m-scope .c2m-ddrow{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;cursor:pointer;font-size:12px;color:#606266}",
      ".c2m-scope .c2m-ddrow:hover{background:#f5f7fa}",
      ".c2m-scope .c2m-ddbox{flex:0 0 auto;width:14px;height:14px;border:1px solid #dcdfe6;border-radius:3px;background:#fff;position:relative;box-sizing:border-box}",
      ".c2m-scope .c2m-ddrow.on .c2m-ddbox{background:#409eff;border-color:#409eff}",
      ".c2m-scope .c2m-ddrow.on .c2m-ddbox::after{content:'';position:absolute;left:3px;top:0px;width:5px;height:9px;border:2px solid #fff;border-top:0;border-left:0;transform:rotate(45deg)}",
      ".c2m-scope .c2m-ddlab{flex:1 1 auto;font-variant-numeric:tabular-nums}",
      ".c2m-scope .c2m-ddw{flex:0 0 auto;color:#a8abb2;font-size:11px}",
      ".c2m-scope .c2m-ddempty{padding:10px 6px;color:#909399;font-size:12px;text-align:center}",
      ".c2m-scope .c2m-field-act{justify-content:flex-end}",
      /* ── 标签徽章（Element Tag）──────────────────────────────────────── */
      ".c2m-scope .c2m-badge{display:inline-block;padding:0 7px;border-radius:4px;font-size:12px;line-height:20px;border:1px solid;white-space:nowrap}",
      ".c2m-scope .c2m-badge.ok{color:#67c23a;border-color:#e1f3d8;background:#f0f9eb}",
      ".c2m-scope .c2m-badge.bad{color:#f56c6c;border-color:#fde2e2;background:#fef0f0}",
      ".c2m-scope .c2m-badge.off{color:#909399;border-color:#e9e9eb;background:#f4f4f5}",
      /* ── 模型清单胶囊（Element Tag 朴素风格，密排时压到 11px）────────── */
      ".c2m-scope .c2m-chips{display:flex;flex-wrap:wrap;gap:4px}",
      ".c2m-scope .c2m-chip{display:inline-block;font-size:11px;line-height:20px;padding:0 8px;border-radius:4px;border:1px solid #e9e9eb;background:#f4f4f5;color:#909399;white-space:nowrap}",
      /* ── 等宽字体（模型名 / key / 时间）──────────────────────────────── */
      ".c2m-scope .c2m-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}",
      ".c2m-scope .c2m-wrap{white-space:normal;word-break:break-word}",
      ".c2m-scope .c2m-nowrap{white-space:nowrap}",
      /* ── 按钮（Element Button：默认白底细边框，主色为实心，删除为红字）── */
      ".c2m-scope .dim-jh-btn{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 13px;font:inherit;font-size:12px;line-height:1;color:#606266;background:#fff;border:1px solid #dcdfe6;border-radius:4px;cursor:pointer;transition:color .15s,border-color .15s,background-color .15s;white-space:nowrap}",
      ".c2m-scope .dim-jh-btn:hover{color:#409eff;border-color:#c6e2ff;background:#ecf5ff}",
      ".c2m-scope .dim-jh-btn:active{color:#3a8ee6;border-color:#3a8ee6}",
      '.c2m-scope .dim-jh-btn[data-act$="-rm"]{color:#f56c6c}',
      '.c2m-scope .dim-jh-btn[data-act$="-rm"]:hover{color:#f56c6c;border-color:#fbc4c4;background:#fef0f0}',
      '.c2m-scope .dim-jh-btn[data-act$="-new"],.c2m-scope .dim-jh-btn[data-act="rec-apply"]{color:#fff;background:#409eff;border-color:#409eff;height:30px;padding:0 16px}',
      '.c2m-scope .dim-jh-btn[data-act$="-new"]:hover,.c2m-scope .dim-jh-btn[data-act="rec-apply"]:hover{color:#fff;background:#66b1ff;border-color:#66b1ff}',
      /* 表格内的操作按钮更紧凑，并禁止换行堆叠（之前竖排两行是主要丑点） */
      ".c2m-scope .c2m-ops{display:flex;gap:6px;justify-content:flex-end;flex-wrap:nowrap}",
      ".c2m-scope .c2m-ops .dim-jh-btn{height:24px;padding:0 9px;font-size:11.5px}",
      /* ── 滚动区 / 左右分栏 ───────────────────────────────────────────── */
      ".c2m-scope .c2m-scroll{max-height:calc(72vh - 170px);overflow:auto}",
      /* 左右分栏：汇总在左、明细在右，各自独立滚动。
         为什么不用上下堆叠：弹窗 max-height 有限，上下两块各带滚动条会叠出
         「弹窗自己滚 + 表格自己滚」的双层滚动，实测滚动区互相打架。 */
      ".c2m-scope .c2m-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:12px;align-items:start}",
      ".c2m-scope .c2m-pane{min-width:0}",
      ".c2m-scope .c2m-pane-scroll{max-height:calc(64vh - 150px);overflow:auto;border:1px solid #ebeef5;border-radius:4px}",
      ".c2m-scope .c2m-pane-scroll .c2d-tbl th{position:sticky;top:0;z-index:1}",
      /* 表头不许折行：左栏窄，宽度一旦不够，浏览器就把「次数」拆成两行。 */
      ".c2m-scope .c2m-pane .c2d-tbl th{white-space:nowrap}",
      ".c2m-scope .c2m-pane .c2d-tbl th.num,.c2m-scope .c2m-pane .c2d-tbl td.num{white-space:nowrap;text-align:right}",
      "@media (max-width:1080px){.c2m-scope .c2m-split{grid-template-columns:minmax(0,1fr)}}",
      /* ── 表单弹层（新建/编辑分组与 Key）────────────────────────────── */
      ".c2m-scope .c2m-form{display:flex;flex-direction:column;gap:14px;min-width:440px}",
      ".c2m-scope .c2m-form label{font-size:13px;color:#606266;display:block;margin-bottom:5px}",
      ".c2m-scope .c2m-form input,.c2m-scope .c2m-form textarea,.c2m-scope .c2m-form select{width:100%;box-sizing:border-box;border:1px solid #dcdfe6;border-radius:4px;padding:6px 10px;font:inherit;font-size:13px;color:#606266;outline:none}",
      ".c2m-scope .c2m-form input:focus,.c2m-scope .c2m-form textarea:focus,.c2m-scope .c2m-form select:focus{border-color:#409eff}",
      ".c2m-scope .c2m-form .err{color:#f56c6c;font-size:12px;min-height:16px}",
      ".c2m-scope .c2m-secret{background:#f0f9eb;border:1px solid #e1f3d8;border-radius:4px;padding:10px 12px;font-family:ui-monospace,monospace;font-size:12.5px;word-break:break-all;color:#67c23a;margin:10px 0}",
      ".c2m-scope .c2m-row{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}",
    ].join("\n");
    document.head.appendChild(st);
  }

  /* ── 弹窗状态 ─────────────────────────────────────────────────────── */

  var overlay = null;
  var state = {
    tab: "groups",
    data: null,           // caller-admin state 动作的返回
    records: null,        // records 动作的返回
    filter: { caller: "", model: "", status: "" },
    days: [],             // 选中的日期
    daysOpen: false,      // 日期下拉是否展开
    // 上次成功加载的 state 快照：再次打开弹窗时先用它渲染，再去后台刷新。
    // 这样「点开 → 有内容」不用等任何请求（实测 state 冷启动要 1.0s）。
    cached: null,
  };

  function section(title, body) {
    return '<div class="c2d-section"><div class="c2d-sectionTitle">' + esc(title) + "</div>" + body + "</div>";
  }

  function table(headers, rows, colWidths) {
    var th = headers.map(function (h) {
      var cls = h.num ? ' class="num"' : "";
      return "<th" + cls + ">" + esc(h.label) + "</th>";
    }).join("");
    var tb = rows.length === 0
      ? '<tr><td colspan="' + headers.length + '" class="c2d-empty">暂无数据</td></tr>'
      : rows.map(function (r) { return "<tr>" + r + "</tr>"; }).join("");
    /* 给了列宽就切固定布局：默认的 auto 布局会让「允许的模型」把说明列压到折行、
       又把操作列挤成竖排两行（2026-11-02 用户报「好多按钮挤在一起」）。 */
    var cg = Array.isArray(colWidths) && colWidths.length === headers.length
      ? "<colgroup>" + colWidths.map(function (w) { return w ? '<col style="width:' + w + '">' : "<col>"; }).join("") + "</colgroup>"
      : "";
    var cls = cg ? "c2d-tbl c2d-tbl-fixed" : "c2d-tbl";
    return '<table class="' + cls + '">' + cg + "<thead><tr>" + th + "</tr></thead><tbody>" + tb + "</tbody></table>";
  }

  /* 表格里的一排操作按钮：横排、不换行、间距统一（竖着堆两个按钮是之前最丑的地方）。 */
  function ops(buttons) {
    return '<div class="c2m-ops">' + buttons.join("") + "</div>";
  }

  function num(v) { return '<td class="num">' + v + "</td>"; }

  /* ── 四个页签 ─────────────────────────────────────────────────────── */

  function renderGroups() {
    var d = state.data;
    if (!d) return '<div class="c2d-empty">加载中…</div>';
    var rows = (d.groups || []).map(function (g) {
      var allow = Array.isArray(g.allow) ? g.allow : [];
      var chips = allow.length
        ? allow.map(function (a) { return '<span class="c2m-chip">' + esc(a) + "</span>"; }).join("")
        : '<span class="c2d-muted">无（全部拒绝）</span>';
      return "<td><strong>" + esc(g.name) + "</strong></td>" +
        '<td class="c2m-wrap">' + esc(g.desc || "") + "</td>" +
        '<td><div class="c2m-chips">' + chips + "</div></td>" +
        "<td>" + ops([
          '<button class="dim-jh-btn" data-act="group-edit" data-name="' + esc(g.name) + '">编辑</button>',
          '<button class="dim-jh-btn" data-act="group-rm" data-name="' + esc(g.name) + '">删除</button>',
        ]) + "</td>";
    });
    return section("分组（白名单）", table(
      [{ label: "分组名" }, { label: "说明" }, { label: "允许的模型" }, { label: "操作" }],
      rows,
      ["11%", "20%", "", "9%"]
    )) +
      '<div style="margin-top:8px"><button class="dim-jh-btn" data-act="group-new">+ 新建分组</button></div>' +
      '<p class="c2d-muted" style="font-size:11.5px;margin-top:8px">白名单支持 <code>*</code>（全部）、<code>provider/*</code>（某渠道全部）、' +
      "完整模型名。<code>aggregate/*</code> 与 <code>jet-hub-auto/*</code> 在白名单不是 <code>*</code> 时必须显式列出。</p>";
  }

  function renderKeys() {
    var d = state.data;
    if (!d) return '<div class="c2d-empty">加载中…</div>';
    var keys = d.keys || [];
    var rows = keys.map(function (k) {
      var badge = k.enabled
        ? '<span class="c2m-badge ok">启用</span>'
        : '<span class="c2m-badge off">停用</span>';
      return "<td class=\"c2m-mono\">" + esc(k.id) + "</td>" +
        '<td class="c2m-wrap">' + esc(k.name) + "</td>" +
        "<td>" + esc(k.group) + "</td>" +
        "<td>" + badge + "</td>" +
        '<td class="c2m-mono">' + esc(k.sha) + "…</td>" +
        '<td class="c2m-nowrap">' + (k.createdAt ? esc(new Date(k.createdAt).toLocaleString("zh-CN")) : "—") + "</td>" +
        "<td>" + ops([
          '<button class="dim-jh-btn" data-act="key-edit" data-id="' + esc(k.id) + '">编辑</button>',
          '<button class="dim-jh-btn" data-act="key-rm" data-id="' + esc(k.id) + '">删除</button>',
        ]) + "</td>";
    });
    var head = table(
      [{ label: "id" }, { label: "名字" }, { label: "分组" }, { label: "状态" },
       { label: "指纹" }, { label: "创建时间" }, { label: "操作" }],
      rows,
      ["13%", "", "11%", "8%", "12%", "16%", "9%"]
    );
    return section("调用方 Key（" + keys.length + " 个）", head) +
      '<div style="margin-top:8px"><button class="dim-jh-btn" data-act="key-new">+ 新建 Key</button></div>' +
      (keys.length === 0
        ? '<p class="c2d-muted" style="font-size:11.5px;margin-top:8px">还没有任何调用方 Key。' +
          "超管 key（网关主 key）不需要在这里建，它始终可用且会照常计入用量。</p>"
        : "");
  }

  function renderUsage() {
    var d = state.data;
    if (!d) return '<div class="c2d-empty">加载中…</div>';
    var u = d.usage || { day: "", rows: [] };
    var rows = (u.rows || []).map(function (r) {
      var isMaster = r.caller === "master";
      return "<td class=\"c2m-mono\">" + esc(r.caller) + (isMaster ? ' <span class="c2m-badge off">超管</span>' : "") + "</td>" +
        "<td>" + esc(r.name) + "</td>" +
        "<td>" + esc(r.group) + "</td>" +
        num(fmt(r.calls)) +
        num(fmtTokens(r.inTokens)) +
        num(fmtTokens(r.outTokens)) +
        num(r.errors > 0 ? '<span style="color:var(--dsw-alias-state-error-primary,#d93025)">' + r.errors + "</span>" : "0") +
        '<td class="c2m-mono" style="font-size:11px">' + esc((r.models || []).slice(0, 3).join(", ")) +
        ((r.models || []).length > 3 ? " +" + ((r.models || []).length - 3) : "") + "</td>";
    });
    var days = (d.usage && d.usage.day) || "";
    return section("按调用方汇总 · " + days, table(
      [{ label: "key" }, { label: "名字" }, { label: "分组" }, { label: "次数", num: true },
       { label: "in", num: true }, { label: "out", num: true }, { label: "错误", num: true },
       { label: "模型" }],
      rows
    )) + '<p class="c2d-muted" style="font-size:11.5px;margin-top:8px">' +
      "流水按天落盘，路径 <code>" + esc(d.storePath || "") + "</code> 同级 <code>caller-usage/</code>。" +
      "看逐次明细、按模型汇总与历史日期，请切到「调用记录」页签。</p>";
  }

  function renderRecords() {
    var r = state.records;
    if (!r) return '<div class="c2d-empty">加载中…</div>';

    var availDays = r.availableDays || [];
    /* 日期改用下拉多选（见 handleDaysClick 附近的说明），不再渲染原生
       select multiple —— 那个按 Ctrl 才能多选、且固定占三行高。 */
    var presetBtns = [["latest", "最近一天"], ["3", "最近 3 天"], ["7", "最近 7 天"],
                      ["all", "全部"], ["none", "清空"]]
      .map(function (p) {
        var on = presetMatches(p[0]) ? " on" : "";
        return '<button type="button" class="c2m-preset' + on + '" data-preset="' + p[0] + '">' + p[1] + "</button>";
      }).join("");
    var dayRows = availDays.map(function (day) {
      var on = state.days.indexOf(day) >= 0 ? " on" : "";
      return '<div class="c2m-ddrow' + on + '" data-day="' + esc(day) + '">' +
        '<span class="c2m-ddbox"></span>' +
        '<span class="c2m-ddlab">' + esc(day) + "</span>" +
        '<span class="c2m-ddw">' + esc(wd(day)) + "</span></div>";
    }).join("");
    /* 可选日期为空（还没跑过流量）时给一句空态，免得下拉点开是一片空白。 */
    if (!dayRows) dayRows = '<div class="c2m-ddempty">还没有任何调用日志</div>';

    var callerOpts = ['<option value="">全部调用方</option>']
      .concat((state.data && state.data.keys || []).map(function (k) {
        return '<option value="' + esc(k.id) + '">' + esc(k.id + " · " + k.name) + "</option>";
      }))
      .concat(['<option value="master">master · 上游网关主 key</option>'])
      .join("");

    var modelOpts = ['<option value="">全部模型</option>']
      .concat((r.byModel || []).map(function (m) {
        return '<option value="' + esc(m.model) + '">' + esc(m.model) + "</option>";
      }))
      .join("");

    var filters =
      '<div class="c2m-filters">' +
      '<div class="c2m-field c2m-field-days"><label>日期（可多选，最多 31 天）</label>' +
      '<div class="c2m-dd" data-open="' + (state.daysOpen ? "1" : "0") + '">' +
      '<button type="button" class="c2m-ddbtn" data-act="days-toggle">' +
      '<span data-c2m-dayslabel>' + esc(daysText(state.days)) + "</span>" +
      '<span class="c2m-ddarrow">▾</span></button>' +
      '<div class="c2m-ddpanel" data-c2m-ddpanel' + (state.daysOpen ? "" : " hidden") + '>' +
      '<div class="c2m-ddpre">' + presetBtns + "</div>" +
      '<div class="c2m-ddlist">' + dayRows + "</div>" +
      "</div></div></div>" +
      '<div class="c2m-field"><label>调用方</label><select data-role="caller">' + callerOpts + "</select></div>" +
      '<div class="c2m-field"><label>模型</label><select data-role="model">' + modelOpts + "</select></div>" +
      '<div class="c2m-field"><label>结果</label><select data-role="status">' +
      '<option value="">全部</option><option value="ok">成功</option><option value="error">失败</option></select></div>' +
      '<div class="c2m-field c2m-field-act"><label>&nbsp;</label>' +
      '<button class="dim-jh-btn" data-act="rec-apply">查询</button></div>' +
      "</div>";

    var byModelRows = (r.byModel || []).slice(0, 12).map(function (m) {
      var callers = Object.keys(m.byCaller || {}).map(function (c) {
        return c + "×" + m.byCaller[c];
      }).join(", ");
      /* 左栏一共只有一格宽度，列太多表头会被压成「次/数」「平均耗/时」两行。
         故 in / out 合成一列「token in·out」，错误数挂到次数列后面。 */
      return "<td class=\"c2m-mono c2m-wrap\" style=\"font-size:11.5px\">" + esc(m.model) + "</td>" +
        num(fmt(m.calls) + (m.errors > 0 ? ' <span class="c2m-badge bad">' + fmt(m.errors) + " 错</span>" : "")) +
        num('<span class="c2m-mono">' + fmtTokens(m.inTokens) + " / " + fmtTokens(m.outTokens) + "</span>") +
        num(m.avgMs == null ? "—" : fmt(m.avgMs) + " ms") +
        '<td class="c2d-muted c2m-wrap" style="font-size:11px">' + esc(callers) + "</td>";
    });

    var detailRows = (r.rows || []).map(function (x) {
      var bad = Number(x.status) >= 400;
      return '<td class="c2m-mono">' + esc(hhmmss(x.ts)) + "</td>" +
        '<td class="c2m-mono">' + esc(x.caller) + "</td>" +
        '<td class="c2m-mono" style="font-size:11px">' + esc(x.model) + "</td>" +
        "<td>" + (bad
          ? '<span class="c2m-badge bad">' + esc(x.status) + "</span>"
          : '<span class="c2m-badge ok">' + esc(x.status) + "</span>") + "</td>" +
        num(x.ms == null ? "—" : fmt(x.ms) + " ms") +
        num(fmtTokens(x.in_tokens)) +
        num(fmtTokens(x.out_tokens)) +
        "<td>" + (x.stream ? "流式" : "一次性") + "</td>";
    });

    /* 左右分栏：汇总在左、明细在右。之前上下堆叠会顶破弹窗高度，
       出现「弹窗自己滚 + 表格自己滚」的双层滚动条。 */
    return filters +
      '<div class="c2m-split">' +
      '<div class="c2m-pane c2m-pane-left">' +
      section("按模型汇总 · 共 " + (r.total || 0) + " 次调用",
        '<div class="c2m-pane-scroll">' + table([{ label: "模型" }, { label: "次数", num: true },
          { label: "token in / out", num: true }, { label: "平均耗时", num: true },
          { label: "谁在调" }], byModelRows) + "</div>") +
      "</div>" +
      '<div class="c2m-pane c2m-pane-right">' +
      section("逐条明细 · 最近 " + (r.shown || 0) + " / 共 " + (r.total || 0) + " 条",
        '<div class="c2m-pane-scroll">' + table(
          [{ label: "时间" }, { label: "调用方" }, { label: "模型" }, { label: "状态" },
           { label: "耗时", num: true }, { label: "in", num: true }, { label: "out", num: true },
           { label: "方式" }], detailRows) + "</div>") +
      "</div></div>" +
      '<p class="c2d-muted" style="font-size:11.5px;margin-top:6px">' +
      "记录只含元数据（调用方、模型、状态、耗时、token 数），<strong>不落 prompt / 回复正文</strong>。" +
      "日期多选可跨天查询，最多 31 天。</p>";
  }

  var TABS = [
    { key: "groups", label: "分组", render: renderGroups, count: function (d) { return (d.groups || []).length; } },
    { key: "keys", label: "Key", render: renderKeys, count: function (d) { return (d.keys || []).length; } },
    { key: "usage", label: "用量", render: renderUsage },
    { key: "records", label: "调用记录", render: renderRecords },
  ];

  function bodyHtml() {
    var d = state.data;
    var tabs = TABS.map(function (t) {
      var n = d && t.count ? '<span class="n">' + t.count(d) + "</span>" : "";
      return '<button class="c2m-tab' + (state.tab === t.key ? " on" : "") +
        '" data-tab="' + t.key + '">' + esc(t.label) + n + "</button>";
    }).join("");
    var cur = TABS.filter(function (t) { return t.key === state.tab; })[0] || TABS[0];
    return '<div class="c2m-tabs">' + tabs + "</div>" + cur.render();
  }

  function repaint() {
    if (!overlay) return;
    var host = overlay.querySelector(".c2m-scope");
    if (host) host.innerHTML = bodyHtml();
    var sub = overlay.querySelector("#c2m-sub");
    if (sub && state.data) {
      sub.textContent = (state.data.keys || []).length + " 个 Key · " +
        (state.data.groups || []).length + " 个分组";
    }
  }

  /* ── 数据 ─────────────────────────────────────────────────────────── */

  async function call(payload) {
    var res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  async function loadState() {
    state.data = await call({ action: "state" });
    state.cached = state.data;
    if (state.days.length === 0) {
      var avail = state.data.usage && state.data.usage.day ? [state.data.usage.day] : [];
      state.days = avail;
    }
  }

  async function loadRecords() {
    state.records = await call({
      action: "records",
      days: state.days,
      filter: state.filter,
      limit: 300,
    });
  }

  /**
   * 拉数据并重画。
   *
   * ⚠️ 性能口径（2026-11-02 用户报「点开很慢」后改）：
   *   - state 与 records **并行**发，不要串行等待（原来 records 要等 state 回来）。
   *   - 只在第一次打开时阻塞渲染；再次打开先用 state.cached 立即出内容，
   *     后台刷新完再替换，用户感知的是「秒开」。
   */
  async function refresh(which) {
    try {
      var jobs = [];
      var needState = which !== "records";
      var needRecords = which !== "state";
      if (needState) jobs.push(loadState());
      // records 与 state 并行是安全的：state.days 为空时后端会按「今天」兜底，
      // 而 loadState 拿到的 usage.day 同样来自今天 — 两者口径一致。
      if (needRecords) jobs.push(loadRecords());
      await Promise.all(jobs);
      repaint();
    } catch (err) {
      var host = overlay && overlay.querySelector(".c2m-scope");
      if (host) host.innerHTML = '<div class="c2d-empty">加载失败：' + esc(err.message) + "</div>";
    }
  }

  /* ── 表单弹层（新建/编辑组与 key）────────────────────────────────── */

  function formModal(title, fields, onOk) {
    var wrap = document.createElement("div");
    wrap.className = "dim-jh-modalOverlay";
    wrap.style.zIndex = 3200;
    wrap.innerHTML =
      '<div role="dialog" aria-modal="true" class="dim-jh-modal c2m-scope" data-scope="c2m" style="width:520px">' +
      '<div class="dim-jh-modalHead"><div class="dim-jh-modalTitle"><strong>' + esc(title) + "</strong></div></div>" +
      '<div class="dim-jh-modalBody"><div class="c2m-form">' +
      fields.map(function (f) {
        var input;
        if (f.type === "textarea") {
          input = '<textarea data-k="' + f.key + '" rows="3">' + esc(f.value || "") + "</textarea>";
        } else if (f.type === "select") {
          input = '<select data-k="' + f.key + '">' + f.options.map(function (o) {
            return '<option value="' + esc(o.value) + '"' +
              (String(o.value) === String(f.value) ? " selected" : "") + ">" + esc(o.label) + "</option>";
          }).join("") + "</select>";
        } else {
          input = '<input data-k="' + f.key + '" type="text" value="' + esc(f.value || "") + '">';
        }
        return "<div><label>" + esc(f.label) + "</label>" + input +
          (f.hint ? '<div class="c2d-muted" style="font-size:11px">' + esc(f.hint) + "</div>" : "") + "</div>";
      }).join("") +
      '<div class="err"></div></div>' +
      '<div class="c2m-row"><button class="dim-jh-btn" data-x="cancel">取消</button>' +
      '<button class="dim-jh-btn" data-x="ok" style="border-color:var(--dsw-alias-brand-primary,#1677ff);color:var(--dsw-alias-brand-primary,#1677ff)">确定</button></div>' +
      "</div></div>";
    document.body.appendChild(wrap);

    function collect() {
      var out = {};
      wrap.querySelectorAll("[data-k]").forEach(function (el) { out[el.getAttribute("data-k")] = el.value; });
      return out;
    }
    function done() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }

    wrap.querySelector('[data-x="cancel"]').addEventListener("click", done);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) done(); });
    wrap.querySelector('[data-x="ok"]').addEventListener("click", async function () {
      var errEl = wrap.querySelector(".err");
      errEl.textContent = "";
      try {
        await onOk(collect());
        done();
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
    return wrap;
  }

  function groupFields(g) {
    return [
      { key: "name", label: "分组名", value: g ? g.name : "", hint: "建好后不建议改名（Key 按名字引用它）" },
      { key: "desc", label: "说明", value: g ? g.desc : "" },
      {
        key: "allow", label: "白名单（逗号或换行分隔）", type: "textarea",
        value: g ? (g.allow || []).join("\n") : "*",
        hint: "* = 全部；provider/* = 该渠道全部；也可写完整模型名",
      },
    ];
  }

  function keyFields(k) {
    var groups = (state.data && state.data.groups || []).map(function (g) {
      return { value: g.name, label: g.name + (g.desc ? " · " + g.desc : "") };
    });
    if (groups.length === 0) groups = [{ value: "full", label: "full（还没有分组，先建分组）" }];
    return [
      { key: "name", label: "名字（给谁用）", value: k ? k.name : "" },
      { key: "group", label: "分组（决定能调哪些模型）", type: "select", options: groups,
        value: k ? k.group : groups[0].value },
      {
        key: "enabled", label: "状态", type: "select",
        options: [{ value: "true", label: "启用" }, { value: "false", label: "停用" }],
        value: k && k.enabled === false ? "false" : "true",
      },
    ];
  }

  function splitAllow(text) {
    return String(text || "")
      .split(/[\n,、;；]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  async function onAct(act, el) {
    var id = el.getAttribute("data-id");
    var name = el.getAttribute("data-name");
    try {
      if (act === "group-new") {
        formModal("新建分组", groupFields(null), async function (v) {
          await call({ action: "group.save", name: v.name.trim(), desc: v.desc, allow: splitAllow(v.allow) });
          await refresh("state");
        });
      } else if (act === "group-edit") {
        var g = (state.data.groups || []).filter(function (x) { return x.name === name; })[0];
        formModal("编辑分组 · " + name, groupFields(g), async function (v) {
          await call({ action: "group.save", name: name, desc: v.desc, allow: splitAllow(v.allow) });
          await refresh("state");
        });
      } else if (act === "group-rm") {
        if (!confirm("删除分组 " + name + "？被 Key 引用时会拒绝。")) return;
        await call({ action: "group.rm", name: name });
        await refresh("state");
      } else if (act === "key-new") {
        formModal("新建 Key", keyFields(null), async function (v) {
          var out = await call({
            action: "key.add",
            name: v.name.trim(),
            group: v.group,
            enabled: v.enabled === "true",
          });
          await refresh("state");
          if (out && out.secret) {
            var shown = document.createElement("div");
            shown.className = "dim-jh-modalOverlay";
            shown.style.zIndex = 3300;
            shown.innerHTML =
              '<div role="dialog" aria-modal="true" class="dim-jh-modal c2m-scope" style="width:560px">' +
              '<div class="dim-jh-modalHead"><div class="dim-jh-modalTitle"><strong>新 Key 已创建</strong>' +
              '<span class="dim-jh-modalSubtitle">这串明文只显示这一次</span></div></div>' +
              '<div class="dim-jh-modalBody"><p class="dim-jh-modalHint">复制给调用方，关掉就再也看不到了（服务端只存哈希）。</p>' +
              '<div class="c2m-secret">' + esc(out.secret) + "</div>" +
              '<div class="c2m-row"><button class="dim-jh-btn" data-x="copy">复制</button>' +
              '<button class="dim-jh-btn" data-x="close">关闭</button></div></div></div>';
            document.body.appendChild(shown);
            shown.querySelector('[data-x="close"]').addEventListener("click", function () { shown.remove(); });
            shown.querySelector('[data-x="copy"]').addEventListener("click", function () {
              navigator.clipboard.writeText(out.secret).then(function () {
                shown.querySelector('[data-x="copy"]').textContent = "已复制";
              });
            });
          }
        });
      } else if (act === "key-edit") {
        var k = (state.data.keys || []).filter(function (x) { return x.id === id; })[0];
        formModal("编辑 Key · " + id, keyFields(k), async function (v) {
          await call({
            action: "key.update",
            id: id,
            name: v.name.trim(),
            group: v.group,
            enabled: v.enabled === "true",
          });
          await refresh("state");
        });
      } else if (act === "key-rm") {
        if (!confirm("删除 Key " + id + "？删掉后它立刻不能调用。")) return;
        await call({ action: "key.rm", id: id });
        await refresh("state");
      } else if (act === "rec-apply") {
        await refresh("records");
      }
    } catch (err) {
      alert(err.message);
    }
  }

  /* ── 弹窗骨架（复用原生 .dim-jh-modal*）──────────────────────────── */

  function build() {
    var ov = document.createElement("div");
    ov.className = "dim-jh-modalOverlay";
    ov.innerHTML =
      '<div role="dialog" aria-modal="true" aria-label="调用方" class="dim-jh-modal dim-jh-modal--ledger"' +
      ' style="width:min(1180px,calc(100vw - 48px));max-height:min(780px,calc(100vh - 48px))">' +
      '<div class="dim-jh-modalHead">' +
      '<div class="dim-jh-modalTitle"><strong>调用方</strong>' +
      '<span class="dim-jh-modalSubtitle" id="c2m-sub">加载中…</span></div>' +
      '<div class="dim-jh-modelPanelActions">' +
      '<button class="dim-jh-btn" id="c2m-refresh">刷新</button>' +
      '<button class="dim-jh-btn" id="c2m-close">关闭</button>' +
      "</div></div>" +
      '<p class="dim-jh-modalHint">token 分发：分组决定能用哪些模型，Key 决定谁在调；' +
      "用量与调用记录按 key / 模型实时汇总，超管 key 一并统计。</p>" +
      '<div class="dim-jh-modalBody"><div class="c2m-scope c2d-body" id="c2m-body">加载中…</div></div>' +
      "</div>";

    ov.addEventListener("click", function (e) {
      if (e.target === ov) { close(); return; }
      var tab = e.target.closest && e.target.closest("[data-tab]");
      if (tab) {
        state.tab = tab.getAttribute("data-tab");
        state.daysOpen = false;
        repaint();
        if (state.tab === "records" && !state.records) refresh("records");
        return;
      }
      /* 日期下拉排在 [data-act] 之前：它的开关自己就是 data-act，
         而面板里的勾选行不是动作按钮，必须先让日期控件消化掉。 */
      if (handleDaysClick(e)) return;
      var actEl = e.target.closest && e.target.closest("[data-act]");
      if (actEl) onAct(actEl.getAttribute("data-act"), actEl);
    });

    ov.addEventListener("change", function (e) {
      var role = e.target.getAttribute && e.target.getAttribute("data-role");
      if (!role) return;
      if (role === "caller" || role === "model" || role === "status") {
        state.filter[role] = e.target.value;
      }
    });

    ov.querySelector("#c2m-close").addEventListener("click", close);
    ov.querySelector("#c2m-refresh").addEventListener("click", function () {
      state.records = null;
      refresh();
    });
    return ov;
  }

  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) { if (e.key === "Escape" && overlay) close(); }

  function open() {
    ensureStyle();
    if (overlay) return;
    overlay = build();
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    // 有上次的快照就先把内容画出来（毫秒级），随后 refresh 再更新 ——
    // 否则用户点开后要盯着「加载中…」等 state 请求（冷启动可达 1s）。
    if (state.cached) {
      state.data = state.cached;
      if (state.records) repaint();
      else {
        state.tab = "groups";
        repaint();
      }
    }
    refresh();
  }

  /* ── 按钮注入（与看板同一套策略：常驻 observer + 兜底轮询）──────── */

  function mountButton() {
    if (document.querySelector("[" + MOUNTED_ATTR + "]")) return true;
    var actions = document.querySelector(".dim-jh-headerActions");
    var host = actions || document.querySelector(".dim-jh-header") || document.querySelector("header");
    if (!host) return false;
    var btn = document.createElement("button");
    btn.className = "dim-jh-btn";
    btn.setAttribute(MOUNTED_ATTR, "1");
    btn.title = "调用方：分组白名单、分发 Key、按 key/模型的用量与逐次调用记录。";
    btn.textContent = "调用方";
    btn.addEventListener("click", open);
    // 紧跟在「总览」后面（总览被要求排在供应商之前，调用方跟它并排即可）。
    const dashBtn = document.querySelector("[data-c2d-btn]");
    if (dashBtn && dashBtn.parentNode === host) host.insertBefore(btn, dashBtn.nextSibling);
    else host.insertBefore(btn, host.firstChild);
    return true;
  }

  var raf = 0;
  var obs = new MutationObserver(function () {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; mountButton(); });
  });
  if (!mountButton()) {
    obs.observe(document.documentElement, { childList: true, subtree: true });
    var t0 = setInterval(function () { if (mountButton()) clearInterval(t0); }, 500);
  } else {
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
`

/**
 * 返回一个 handler：命中 UI_PATH 就吐脚本体，否则返回 false 交给下一个处理器。
 * 与 `caller-admin.js` / `dashboard-admin.js` 的 handle 同签名。
 */
export function createCallersUiHandler() {
  const body = Buffer.from(UI_SRC, "utf8")
  return function handle(request, response, url) {
    if (url.pathname !== UI_PATH) return false
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" })
      response.end("Method Not Allowed")
      return true
    }
    response.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-store",
    })
    response.end(request.method === "HEAD" ? undefined : body)
    return true
  }
}

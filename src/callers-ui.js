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
  function pad2(n) { return String(n).padStart(2, "0"); }
  function localDay(value) {
    var d = value instanceof Date ? value : new Date(value);
    if (!isFinite(d.getTime())) return "";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function dayHead(day) {
    if (!day) return "日期未知";
    var now = new Date();
    var yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    var p = String(day).split("-");
    var md = p.length === 3 ? Number(p[1]) + " 月 " + Number(p[2]) + " 日" : String(day);
    var lead = day === localDay(now) ? "今天" : day === localDay(yest) ? "昨天" : p[0] + " 年";
    return lead + " · " + md + " " + wd(day);
  }
  function fmtMs(ms) {
    var v = Number(ms);
    if (ms == null || !isFinite(v)) return "—";
    if (v < 1000) return Math.round(v) + " ms";
    if (v < 60000) return (v / 1000).toFixed(1) + " s";
    var s = Math.round(v / 1000);
    return Math.floor(s / 60) + " 分 " + pad2(s % 60) + " 秒";
  }
  var STATUS_TEXT = {
    400: "请求有误", 401: "Key 无效", 403: "无权调用", 404: "模型不存在", 408: "请求超时",
    413: "请求过大", 429: "被限流", 500: "服务出错", 502: "上游出错", 503: "暂不可用", 504: "上游超时",
  };
  var CODE_TEXT = {
    rate_limit_exceeded: "被限流", insufficient_quota: "额度不足", quota_exceeded: "额度不足",
    model_not_allowed: "无权调用", model_disabled: "模型已关闭", invalid_api_key: "Key 无效",
    context_length_exceeded: "上下文超长", gateway_unreachable: "网关不可达", server_error: "服务出错",
    timeout: "超时", upstream_error: "上游出错",
  };
  function statusReason(x) {
    if (x.error_code) return CODE_TEXT[x.error_code] || String(x.error_code);
    var s = Number(x.status);
    return STATUS_TEXT[s] || (s >= 500 ? "服务出错" : "请求失败");
  }
  function recKey(x) {
    return [x.ts, x.caller, x.model, x.status, x.ms, x.in_tokens, x.out_tokens].join("|");
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
    updateAutoUi();
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
    st.textContent = [
      /* ── 作用域：一切样式只作用于调用方弹窗内部，不污染 /admin 其它区域 ── */
      /* ── 表格（Element Table 外观）────────────────────────────────── */
      ".c2m-scope .c2d-tbl{width:100%;border-collapse:collapse;table-layout:auto;font-size:13px;color:var(--c2-text-2);background:var(--c2-surface);border-radius:4px}",
      ".c2m-scope .c2d-tbl th{background:var(--c2-surface-2);color:var(--c2-text-3);font-weight:600;font-size:13px;text-align:left;padding:8px 12px;border-bottom:1px solid var(--c2-border-soft);white-space:nowrap}",
      ".c2m-scope .c2d-tbl td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--c2-border-soft);color:var(--c2-text-2);font-size:13px;vertical-align:middle;line-height:1.5}",
      ".c2m-scope .c2d-tbl tbody tr:hover > td{background:var(--c2-surface-2)}",
      ".c2m-scope .c2d-tbl tr:last-child > td{border-bottom:0}",
      ".c2m-scope .c2d-tbl .num{text-align:right;font-variant-numeric:tabular-nums}",
      /* 固定列宽的表：溢出省略，避免长模型名把操作列挤成两行 */
      ".c2m-scope .c2d-tbl-fixed{table-layout:fixed}",
      ".c2m-scope .c2m-tblWrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--c2-border-soft);border-radius:8px}",
      "@media (max-width:720px){.c2m-scope .c2m-tblWrap>.c2d-tbl{min-width:680px}.c2m-scope .c2m-filters{padding:10px}.c2m-scope .c2m-field{flex:1 1 140px}.c2m-scope .c2m-ddbtn{min-width:0;max-width:none;width:100%}.c2m-scope .c2m-tabs{gap:18px}}",
      ".c2m-scope .c2d-tbl-fixed td,.c2m-scope .c2d-tbl-fixed th{overflow:hidden;text-overflow:ellipsis}",
      /* ── 区块 / 空态 / 次要文字（原先靠看板注入，弹窗单独打开时就缺失）── */
      ".c2m-scope .c2d-section{margin-bottom:4px}",
      ".c2m-scope .c2d-sectionTitle{font-size:13px;font-weight:600;color:var(--c2-text);margin:0 0 10px}",
      ".c2m-scope .c2d-muted{color:var(--c2-text-3)}",
      ".c2m-scope .c2d-empty{padding:28px 12px;text-align:center;color:var(--c2-text-3);font-size:13px}",
      /* ── 页签（Element Tabs：底部 2px 主色条）────────────────────────── */
      ".c2m-scope .c2m-tabs{display:flex;gap:32px;border-bottom:1px solid var(--c2-border);margin:0 0 14px}",
      ".c2m-scope .c2m-tab{appearance:none;border:0;background:none;padding:0 0 9px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;color:var(--c2-text);border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .15s}",
      ".c2m-scope .c2m-tab:hover{color:var(--c2-brand)}",
      ".c2m-scope .c2m-tab.on{color:var(--c2-brand);border-bottom-color:var(--c2-brand);font-weight:600}",
      ".c2m-scope .c2m-tab .n{font-size:11px;color:var(--c2-text-3);margin-left:5px;font-weight:400}",
      /* ── 筛选行 ─────────────────────────────────────────────────────── */
      ".c2m-scope .c2m-filters{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin:0 0 12px;padding:12px 14px;border:1px solid var(--c2-border-soft);border-radius:6px;background:var(--c2-surface-2)}",
      ".c2m-scope .c2m-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".c2m-scope .c2m-field label{font-size:12px;color:var(--c2-text-2);line-height:16px}",
      ".c2m-scope .c2m-field select,.c2m-scope .c2m-field input{box-sizing:border-box;height:28px;border:1px solid var(--c2-border);border-radius:4px;padding:0 8px;font:inherit;font-size:12px;background:var(--c2-surface);color:var(--c2-text-2);outline:none;transition:border-color .15s}",
      ".c2m-scope .c2m-field select:hover,.c2m-scope .c2m-field input:hover{border-color:color-mix(in srgb,var(--c2-text-3) 50%,var(--c2-border))}",
      ".c2m-scope .c2m-field select:focus,.c2m-scope .c2m-field input:focus{border-color:var(--c2-brand)}",
      ".c2m-scope .c2m-field-days{position:relative}",
      /* ── 日期下拉（Element Select 风格）────────────────────────────────
         原生 select multiple 要求按 Ctrl 才能多选、且固定三行高，
         换成「按钮 + 浮层面板」，点一下即切换。 */
      ".c2m-scope .c2m-dd{position:relative;display:inline-block}",
      ".c2m-scope .c2m-ddbtn{box-sizing:border-box;height:28px;min-width:196px;max-width:260px;display:inline-flex;align-items:center;gap:6px;justify-content:space-between;border:1px solid var(--c2-border);border-radius:4px;padding:0 8px;font:inherit;font-size:12px;background:var(--c2-surface);color:var(--c2-text-2);cursor:pointer;text-align:left;transition:border-color .15s}",
      ".c2m-scope .c2m-ddbtn:hover{border-color:color-mix(in srgb,var(--c2-text-3) 50%,var(--c2-border))}",
      ".c2m-scope .c2m-dd[data-open='1'] .c2m-ddbtn{border-color:var(--c2-brand)}",
      ".c2m-scope .c2m-ddbtn>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".c2m-scope .c2m-ddarrow{flex:0 0 auto;color:var(--c2-text-3);font-size:10px}",
      ".c2m-scope .c2m-ddpanel{position:absolute;z-index:20;top:calc(100% + 4px);left:0;width:252px;background:var(--c2-surface);border:1px solid var(--c2-border);border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.1);padding:8px}",
      ".c2m-scope .c2m-ddpanel[hidden]{display:none}",
      ".c2m-scope .c2m-ddpre{display:flex;gap:6px;flex-wrap:wrap;padding-bottom:8px;margin-bottom:6px;border-bottom:1px solid var(--c2-border-soft)}",
      ".c2m-scope .c2m-preset{appearance:none;border:1px solid var(--c2-border);background:var(--c2-surface);color:var(--c2-text-2);border-radius:4px;font:inherit;font-size:11.5px;line-height:20px;padding:0 8px;cursor:pointer;transition:all .15s}",
      ".c2m-scope .c2m-preset:hover{color:var(--c2-brand);border-color:color-mix(in srgb,var(--c2-brand) 35%,var(--c2-border));background:var(--c2-brand-soft)}",
      ".c2m-scope .c2m-preset.on{color:#fff;background:var(--c2-brand);border-color:var(--c2-brand)}",
      ".c2m-scope .c2m-ddlist{max-height:196px;overflow:auto}",
      ".c2m-scope .c2m-ddrow{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;cursor:pointer;font-size:12px;color:var(--c2-text-2)}",
      ".c2m-scope .c2m-ddrow:hover{background:var(--c2-surface-2)}",
      ".c2m-scope .c2m-ddbox{flex:0 0 auto;width:14px;height:14px;border:1px solid var(--c2-border);border-radius:3px;background:var(--c2-surface);position:relative;box-sizing:border-box}",
      ".c2m-scope .c2m-ddrow.on .c2m-ddbox{background:var(--c2-brand);border-color:var(--c2-brand)}",
      ".c2m-scope .c2m-ddrow.on .c2m-ddbox::after{content:'';position:absolute;left:3px;top:0px;width:5px;height:9px;border:2px solid #fff;border-top:0;border-left:0;transform:rotate(45deg)}",
      ".c2m-scope .c2m-ddlab{flex:1 1 auto;font-variant-numeric:tabular-nums}",
      ".c2m-scope .c2m-ddw{flex:0 0 auto;color:var(--c2-text-3);font-size:11px}",
      ".c2m-scope .c2m-ddempty{padding:10px 6px;color:var(--c2-text-3);font-size:12px;text-align:center}",
      ".c2m-scope .c2m-field-act{justify-content:flex-end}",
      /* ── 标签徽章（Element Tag）──────────────────────────────────────── */
      ".c2m-scope .c2m-badge{display:inline-block;padding:0 7px;border-radius:4px;font-size:12px;line-height:20px;border:1px solid;white-space:nowrap}",
      ".c2m-scope .c2m-badge.ok{color:var(--c2-ok);border-color:color-mix(in srgb,var(--c2-ok) 30%,var(--c2-border));background:var(--c2-ok-soft)}",
      ".c2m-scope .c2m-badge.bad{color:var(--c2-err);border-color:color-mix(in srgb,var(--c2-err) 30%,var(--c2-border));background:var(--c2-err-soft)}",
      ".c2m-scope .c2m-badge.off{color:var(--c2-text-3);border-color:var(--c2-border-soft);background:var(--c2-surface-2)}",
      /* ── 模型清单胶囊（Element Tag 朴素风格，密排时压到 11px）────────── */
      ".c2m-scope .c2m-chips{display:flex;flex-wrap:wrap;gap:4px}",
      ".c2m-scope .c2m-chip{display:inline-block;font-size:11px;line-height:20px;padding:0 8px;border-radius:4px;border:1px solid var(--c2-border-soft);background:var(--c2-surface-2);color:var(--c2-text-3);white-space:nowrap}",
      /* ── 等宽字体（模型名 / key / 时间）──────────────────────────────── */
      ".c2m-scope .c2m-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}",
      ".c2m-scope .c2m-wrap{white-space:normal;word-break:break-word}",
      ".c2m-scope .c2m-nowrap{white-space:nowrap}",
      /* ── 按钮（Element Button：默认白底细边框，主色为实心，删除为红字）── */
      ".c2m-scope .dim-jh-btn{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 13px;font:inherit;font-size:12px;line-height:1;color:var(--c2-text-2);background:var(--c2-surface);border:1px solid var(--c2-border);border-radius:4px;cursor:pointer;transition:color .15s,border-color .15s,background-color .15s;white-space:nowrap}",
      ".c2m-scope .dim-jh-btn:hover{color:var(--c2-brand);border-color:color-mix(in srgb,var(--c2-brand) 35%,var(--c2-border));background:var(--c2-brand-soft)}",
      ".c2m-scope .dim-jh-btn:active{color:var(--c2-brand);border-color:var(--c2-brand)}",
      '.c2m-scope .dim-jh-btn[data-act$="-rm"]{color:var(--c2-err)}',
      '.c2m-scope .dim-jh-btn[data-act$="-rm"]:hover{color:var(--c2-err);border-color:color-mix(in srgb,var(--c2-err) 40%,var(--c2-border));background:var(--c2-err-soft)}',
      '.c2m-scope .dim-jh-btn[data-act$="-new"],.c2m-scope .dim-jh-btn[data-act="rec-apply"]{color:#fff;background:var(--c2-brand);border-color:var(--c2-brand);height:30px;padding:0 16px}',
      '.c2m-scope .dim-jh-btn[data-act$="-new"]:hover,.c2m-scope .dim-jh-btn[data-act="rec-apply"]:hover{color:#fff;background:color-mix(in srgb,var(--c2-brand) 85%,#000);border-color:var(--c2-brand)}',
      /* 表格内的操作按钮更紧凑，并禁止换行堆叠（之前竖排两行是主要丑点） */
      ".c2m-scope .c2m-ops{display:flex;gap:6px;justify-content:flex-end;flex-wrap:nowrap}",
      ".c2m-scope .c2m-ops .dim-jh-btn{height:24px;padding:0 9px;font-size:11.5px}",
      /* ── 滚动区 / 左右分栏 ───────────────────────────────────────────── */
      ".c2m-scope .c2m-scroll{max-height:calc(100vh - 300px);overflow:auto}",
      /* 左右分栏：汇总在左、明细在右，各自独立滚动。
         为什么不用上下堆叠：弹窗 max-height 有限，上下两块各带滚动条会叠出
         「弹窗自己滚 + 表格自己滚」的双层滚动，实测滚动区互相打架。 */
      ".c2m-scope .c2m-split{display:grid;grid-template-columns:minmax(0,0.92fr) minmax(0,1.48fr);gap:12px;align-items:start}",
      ".c2m-scope .c2m-pane{min-width:0}",
      ".c2m-scope .c2m-pane-scroll{max-height:calc(100vh - 330px);min-height:240px;overflow:auto;border:1px solid var(--c2-border-soft);border-radius:8px}",
      ".c2m-scope .c2m-pane-scroll .c2d-tbl th{position:sticky;top:0;z-index:1}",
      /* 表头不许折行：左栏窄，宽度一旦不够，浏览器就把「次数」拆成两行。 */
      ".c2m-scope .c2m-pane .c2d-tbl th{white-space:nowrap}",
      ".c2m-scope .c2m-pane .c2d-tbl th.num,.c2m-scope .c2m-pane .c2d-tbl td.num{white-space:nowrap;text-align:right}",
      "@media (max-width:1280px){.c2m-scope .c2m-split{grid-template-columns:minmax(0,1fr)}}",
      ".c2m-scope .c2m-auto{margin-left:auto;align-self:center;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--c2-text-3)}",
      ".c2m-scope .c2m-autodot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--c2-text-3)}",
      ".c2m-scope .c2m-auto[data-mode='on'] .c2m-autodot{background:var(--c2-ok);box-shadow:0 0 0 3px var(--c2-ok-soft)}",
      ".c2m-scope .c2m-auto[data-mode='wait'] .c2m-autodot{background:var(--c2-warn);box-shadow:0 0 0 3px var(--c2-warn-soft)}",
      ".c2m-scope .c2m-auto[data-mode='err'] .c2m-autodot{background:var(--c2-err);box-shadow:0 0 0 3px var(--c2-err-soft)}",
      ".c2m-scope .c2m-auto[data-mode='err'] [data-rec-autotext]{color:var(--c2-err)}",
      ".c2m-scope .c2m-auto .dim-jh-btn{height:26px;padding:0 11px}",
      ".c2m-scope .c2m-rectbl th,.c2m-scope .c2m-rectbl td{padding:7px 8px}",
      ".c2m-scope .c2m-rectbl th{font-size:12px}",
      ".c2m-scope .c2m-recday>td{background:var(--c2-surface-2);color:var(--c2-text-3);font-size:12px;font-weight:600;padding:5px 10px}",
      ".c2m-scope .c2m-rectbl tbody tr.c2m-recday:hover>td{background:var(--c2-surface-2)}",
      ".c2m-scope .c2m-rectime{font-family:var(--c2-mono);font-size:12px;color:var(--c2-text-3);white-space:nowrap}",
      ".c2m-scope .c2m-recnew{display:inline-block;margin-left:6px;padding:0 5px;border-radius:8px;font-size:10px;line-height:16px;color:var(--c2-brand);background:var(--c2-brand-soft);vertical-align:1px}",
      ".c2m-scope .c2m-recwho{display:block;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--c2-text)}",
      ".c2m-scope .c2m-recsub{display:block;font-family:var(--c2-mono);font-size:11px;line-height:15px;color:var(--c2-text-3);white-space:nowrap}",
      ".c2m-scope .c2m-recmodel{display:block;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--c2-mono);font-size:12px;color:var(--c2-text)}",
      ".c2m-scope .c2m-recprov{color:var(--c2-text-3)}",
      ".c2m-scope .c2m-recok{color:var(--c2-ok);white-space:nowrap}",
      ".c2m-scope .c2m-recbad{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}",
      ".c2m-scope .c2m-recwhy{color:var(--c2-err);font-size:12px;max-width:84px;overflow:hidden;text-overflow:ellipsis}",
      ".c2m-scope .c2m-rectbl tbody tr.c2m-recrow.bad>td{background:var(--c2-err-soft)}",
      ".c2m-scope .c2m-recms{display:inline-flex;flex-direction:column;align-items:flex-end;gap:3px;font-family:var(--c2-mono);font-size:12px;white-space:nowrap}",
      ".c2m-scope .c2m-recbar{display:block;width:56px;height:3px;border-radius:2px;background:var(--c2-border-soft);overflow:hidden}",
      ".c2m-scope .c2m-recbar>i{display:block;height:100%;border-radius:2px;background:var(--c2-brand)}",
      ".c2m-scope .c2m-recbar.slow>i{background:var(--c2-warn)}",
      ".c2m-scope .c2m-recbar.bad>i{background:var(--c2-err)}",
      ".c2m-scope .c2m-rectok{font-family:var(--c2-mono);font-size:12px;white-space:nowrap}",
      ".c2m-scope .c2m-recway{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;line-height:18px;white-space:nowrap;color:var(--c2-text-3);border:1px solid var(--c2-border-soft);background:var(--c2-surface-2)}",
      ".c2m-scope .c2m-recway.stream{color:var(--c2-brand);border-color:color-mix(in srgb,var(--c2-brand) 30%,var(--c2-border));background:var(--c2-brand-soft)}",
      ".c2m-scope .c2m-modeltbl th,.c2m-scope .c2m-modeltbl td{padding:8px;vertical-align:middle}",
      ".c2m-scope .c2m-modeltbl th{font-size:12px}",
      ".c2m-scope .c2m-modeltbl .c2m-recmodel{max-width:150px}",
      ".c2m-scope .c2m-mcalls{display:block;font-size:14px;font-weight:600;color:var(--c2-text);font-variant-numeric:tabular-nums}",
      ".c2m-scope .c2m-merr{display:block;font-size:11px;color:var(--c2-err);white-space:nowrap}",
      ".c2m-scope .c2m-mtok{display:block;font-family:var(--c2-mono);font-size:12px;line-height:18px;white-space:nowrap}",
      ".c2m-scope .c2m-mtok>span{margin-right:6px;font-family:inherit;font-size:11px;color:var(--c2-text-3)}",
      ".c2m-scope .c2m-mwhos{display:flex;flex-wrap:wrap;gap:4px}",
      ".c2m-scope .c2m-mwho{display:inline-flex;align-items:center;gap:4px;max-width:84px;padding:0 6px;border-radius:4px;font-size:11px;line-height:18px;color:var(--c2-text-2);border:1px solid var(--c2-border-soft);background:var(--c2-surface-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".c2m-scope .c2m-mwho>b{font-weight:600;color:var(--c2-text-3);font-variant-numeric:tabular-nums}",
      ".c2m-scope .c2m-mwho.more{color:var(--c2-text-3)}",
      ".c2m-scope .c2m-mwho.wide{display:none}",
      "@media (max-width:1280px){.c2m-scope .c2m-mwho.wide{display:inline-flex}.c2m-scope .c2m-mwho.narrow{display:none}}",
      "@media (max-width:1280px){.c2m-scope .c2m-modeltbl .c2m-recmodel{max-width:280px}.c2m-scope .c2m-mwho{max-width:160px}}",
      ".c2m-scope .c2m-mmore>td{font-size:11.5px;color:var(--c2-text-3);text-align:center}",
      "@keyframes c2mRecFresh{from{background:var(--c2-brand-soft)}to{background:transparent}}",
      ".c2m-scope .c2m-recrow.fresh>td{animation:c2mRecFresh 4s ease-out}",
      "@media (max-width:720px){" +
        ".c2m-scope .c2m-auto{margin-left:0;flex:1 1 100%}" +
        ".c2m-scope .c2m-rectbl,.c2m-scope .c2m-rectbl tbody{display:block}" +
        ".c2m-scope .c2m-rectbl thead{display:none}" +
        ".c2m-scope .c2m-recday,.c2m-scope .c2m-recday>td{display:block}" +
        ".c2m-scope .c2m-recrow{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;padding:9px 10px;border-bottom:1px solid var(--c2-border-soft)}" +
        ".c2m-scope .c2m-recrow.bad{background:var(--c2-err-soft)}" +
        ".c2m-scope .c2m-rectbl tbody tr.c2m-recrow>td{display:block;padding:0;border:0;background:none;text-align:left}" +
        ".c2m-scope .c2m-recrow>td.c-model{order:1;flex:1 1 100%}" +
        ".c2m-scope .c2m-recrow>td.c-time{order:2}" +
        ".c2m-scope .c2m-recrow>td.c-who{order:3}" +
        ".c2m-scope .c2m-recrow>td.c-res{order:4;margin-left:auto}" +
        ".c2m-scope .c2m-recrow>td.c-ms,.c2m-scope .c2m-recrow>td.c-in,.c2m-scope .c2m-recrow>td.c-out,.c2m-scope .c2m-recrow>td.c-way{order:5}" +
        ".c2m-scope .c2m-recrow>td[data-l]::before{content:attr(data-l) ' ';font-size:11px;color:var(--c2-text-3)}" +
        ".c2m-scope .c2m-recwho,.c2m-scope .c2m-recsub{display:inline;max-width:none}" +
        ".c2m-scope .c2m-recsub{margin-left:6px}" +
        ".c2m-scope .c2m-recmodel{max-width:none}" +
        ".c2m-scope .c2m-recms{flex-direction:row;align-items:center;gap:6px}" +
        ".c2m-scope .c2m-recbar{width:40px}" +
        ".c2m-scope .c2m-modeltbl,.c2m-scope .c2m-modeltbl tbody{display:block}" +
        ".c2m-scope .c2m-modeltbl thead{display:none}" +
        ".c2m-scope .c2m-modeltbl tbody tr{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;padding:9px 10px;border-bottom:1px solid var(--c2-border-soft)}" +
        ".c2m-scope .c2m-modeltbl tbody tr>td{display:block;padding:0;border:0;text-align:left}" +
        ".c2m-scope .c2m-modeltbl tbody tr>td:first-child{flex:1 1 100%}" +
        ".c2m-scope .c2m-modeltbl tbody tr>td[data-l]::before{content:attr(data-l) ' ';font-size:11px;color:var(--c2-text-3)}" +
        ".c2m-scope .c2m-modeltbl .c2m-mcalls{display:inline;font-size:13px}" +
        ".c2m-scope .c2m-modeltbl .c2m-merr{display:inline;margin-left:6px}" +
        ".c2m-scope .c2m-modeltbl .c2m-mtok{display:inline;margin-right:10px}" +
        ".c2m-scope .c2m-modeltbl .c2m-recmodel{max-width:none}" +
        ".c2m-scope .c2m-modeltbl .c2m-mmore>td{flex:1 1 100%}" +
      "}",
      /* ── 表单弹层（新建/编辑分组与 Key）────────────────────────────── */
      ".c2m-scope .c2m-form{display:flex;flex-direction:column;gap:14px;min-width:min(440px,100%)}",
      ".c2m-scope .c2m-form label{font-size:13px;color:var(--c2-text-2);display:block;margin-bottom:5px}",
      ".c2m-scope .c2m-form input,.c2m-scope .c2m-form textarea,.c2m-scope .c2m-form select{width:100%;box-sizing:border-box;border:1px solid var(--c2-border);border-radius:4px;padding:6px 10px;font:inherit;font-size:13px;color:var(--c2-text-2);outline:none}",
      ".c2m-scope .c2m-form input:focus,.c2m-scope .c2m-form textarea:focus,.c2m-scope .c2m-form select:focus{border-color:var(--c2-brand)}",
      ".c2m-scope .c2m-form .err{color:var(--c2-err);font-size:12px;min-height:16px}",
      ".c2m-scope .c2m-secret{background:var(--c2-ok-soft);border:1px solid color-mix(in srgb,var(--c2-ok) 30%,var(--c2-border));border-radius:4px;padding:10px 12px;font-family:ui-monospace,monospace;font-size:12.5px;word-break:break-all;color:var(--c2-ok);margin:10px 0}",
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
    modelCandidates: [],  // 见过的模型全集（跨查询累积，避免筛选后下拉里其它模型消失）
    days: [],             // 选中的日期
    daysOpen: false,      // 日期下拉是否展开
    // 上次成功加载的 state 快照：再次打开弹窗时先用它渲染，再去后台刷新。
    // 这样「点开 → 有内容」不用等任何请求（实测 state 冷启动要 1.0s）。
    cached: null,
    query: null,
    auto: { on: readAutoOn(), lastAt: 0, busy: false, err: "", fresh: {}, timer: null, visible: false },
  };

  var AUTO_KEY = "c2-rec-auto";
  function autoMs() {
    var v = Number(window.__c2RecAutoMs);
    return v > 0 ? v : 15000;
  }
  function readAutoOn() {
    try { return window.localStorage.getItem("c2-rec-auto") !== "0"; } catch (e) { return true; }
  }
  function writeAutoOn(on) {
    try {
      if (on) window.localStorage.removeItem(AUTO_KEY);
      else window.localStorage.setItem(AUTO_KEY, "0");
    } catch (e) { return; }
  }
  function snapshotQuery() {
    return {
      days: (state.days || []).slice(),
      filter: {
        caller: state.filter.caller || "",
        model: state.filter.model || "",
        status: state.filter.status || "",
      },
    };
  }
  function sameQuery(a, b) {
    return sameSet(a.days, b.days) &&
      a.filter.caller === b.filter.caller && a.filter.model === b.filter.model && a.filter.status === b.filter.status;
  }
  function dirty() {
    return Boolean(state.query) && !sameQuery(state.query, snapshotQuery());
  }

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
    return '<div class="c2m-tblWrap"><table class="' + cls + '">' + cg + "<thead><tr>" + th + "</tr></thead><tbody>" + tb + "</tbody></table></div>";
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

    var cf = state.filter.caller || "";
    var mf = state.filter.model || "";
    var sf = state.filter.status || "";

    var callerOpts = ['<option value=""' + (cf === "" ? " selected" : "") + ">全部调用方</option>"]
      .concat((state.data && state.data.keys || []).map(function (k) {
        return '<option value="' + esc(k.id) + '"' + (k.id === cf ? " selected" : "") + ">"
          + esc(k.id + " · " + k.name) + "</option>";
      }))
      .concat(['<option value="master"' + (cf === "master" ? " selected" : "") + ">master · 上游网关主 key</option>"])
      .join("");

    /* 模型候选来自「跨查询累积」的全集，而不是当前这次（可能已被过滤的）byModel，
       否则按模型筛选后其它模型会从下拉里消失、没法直接切回去。 */
    var modelList = (state.modelCandidates && state.modelCandidates.length
      ? state.modelCandidates
      : (r.byModel || []).map(function (m) { return m.model; })).slice().sort();
    var modelOpts = ['<option value=""' + (mf === "" ? " selected" : "") + ">全部模型</option>"]
      .concat(modelList.map(function (id) {
        return '<option value="' + esc(id) + '"' + (id === mf ? " selected" : "") + ">" + esc(id) + "</option>";
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
      '<option value=""' + (sf === "" ? " selected" : "") + ">全部</option>" +
      '<option value="ok"' + (sf === "ok" ? " selected" : "") + ">成功</option>" +
      '<option value="error"' + (sf === "error" ? " selected" : "") + ">失败</option></select></div>" +
      '<div class="c2m-field c2m-field-act"><label>&nbsp;</label>' +
      '<button class="dim-jh-btn" data-act="rec-apply">查询</button></div>' +
      '<div class="c2m-auto" data-rec-auto data-mode="on">' +
      '<span class="c2m-autodot"></span><span data-rec-autotext></span>' +
      '<button type="button" class="dim-jh-btn" data-act="rec-auto"></button></div>' +
      "</div>";

    /* 左右分栏：汇总在左、明细在右。之前上下堆叠会顶破弹窗高度，
       出现「弹窗自己滚 + 表格自己滚」的双层滚动条。 */
    return filters +
      '<div class="c2m-split">' +
      '<div class="c2m-pane c2m-pane-left">' +
      recSection("model", modelTitle(r), modelHtml(r)) +
      "</div>" +
      '<div class="c2m-pane c2m-pane-right">' +
      recSection("detail", detailTitle(r), detailHtml(r)) +
      "</div></div>" +
      '<p class="c2d-muted" style="font-size:11.5px;margin-top:6px">' +
      "记录只含元数据（调用方、模型、状态、耗时、token 数），<strong>不落 prompt / 回复正文</strong>。" +
      "日期多选可跨天查询，最多 31 天。</p>";
  }

  function recSection(kind, title, body) {
    return '<div class="c2d-section"><div class="c2d-sectionTitle" data-rec-title="' + kind + '">' + esc(title) +
      '</div><div class="c2m-pane-scroll" data-rec-pane="' + kind + '">' + body + "</div></div>";
  }

  function modelTitle(r) {
    return "按模型汇总 · 共 " + fmt(r.total || 0) + " 次调用";
  }

  function detailTitle(r) {
    var bad = (r.byModel || []).reduce(function (n, m) { return n + (Number(m.errors) || 0); }, 0);
    return "逐条明细 · 最近 " + fmt(r.shown || 0) + " / 共 " + fmt(r.total || 0) + " 条" +
      (bad > 0 ? " · 失败 " + fmt(bad) : "");
  }

  function callerName(id) {
    if (id === "master") return "超管";
    var k = ((state.data && state.data.keys) || []).filter(function (x) { return x.id === id; })[0];
    return k && k.name ? k.name : id;
  }

  function modelRows(r) {
    var list = r.byModel || [];
    var maxAvg = list.reduce(function (n, m) { return Math.max(n, Number(m.avgMs) || 0); }, 0);
    var rows = list.slice(0, 12).map(function (m) {
      var model = String(m.model || "");
      var cut = model.indexOf("/");
      var prov = cut > 0 ? model.slice(0, cut) : "";
      var short = cut > 0 ? model.slice(cut + 1) : model;
      var calls = Number(m.calls) || 0;
      var avg = Number(m.avgMs);
      var hasAvg = m.avgMs != null && isFinite(avg);
      var avgPct = hasAvg && maxAvg > 0 ? Math.max(2, Math.round((avg / maxAvg) * 100)) : 0;
      var who = Object.keys(m.byCaller || {})
        .sort(function (a, b) { return m.byCaller[b] - m.byCaller[a]; });
      var label = function (c) { return callerName(c) + " ×" + m.byCaller[c]; };
      var chips = who.slice(0, 3).map(function (c, i) {
        return '<span class="c2m-mwho' + (i > 0 ? " wide" : "") + '" title="' + esc(c) + '">' +
          esc(callerName(c)) + "<b>" + fmt(m.byCaller[c]) + "</b></span>";
      }).join("") +
        (who.length > 1
          ? '<span class="c2m-mwho more narrow" title="' + esc(who.slice(1).map(label).join("、")) + '">+' +
            (who.length - 1) + "</span>"
          : "") +
        (who.length > 3
          ? '<span class="c2m-mwho more wide" title="' + esc(who.slice(3).map(label).join("、")) + '">+' +
            (who.length - 3) + "</span>"
          : "");
      /* 左栏一共只有一格宽度，列太多表头会被压成「次/数」「平均耗/时」两行。
         故 in / out 合成一列「token in·out」，错误数挂到次数列后面。 */
      var cells =
        '<td><span class="c2m-recmodel" title="' + esc(model) + '">' +
        (prov ? '<span class="c2m-recprov">' + esc(prov) + " / </span>" : "") + esc(short) + "</span></td>" +
        '<td class="num" data-l="调用"><span class="c2m-mcalls">' + fmt(calls) + "</span>" +
        (m.errors > 0 ? '<span class="c2m-merr">失败 ' + fmt(m.errors) + "</span>" : "") + "</td>" +
        '<td class="num"><span class="c2m-mtok"><span>输入</span>' + esc(fmtTokens(m.inTokens)) + "</span>" +
        '<span class="c2m-mtok"><span>输出</span>' + esc(fmtTokens(m.outTokens)) + "</span></td>" +
        '<td class="num" data-l="平均"><span class="c2m-recms">' + esc(fmtMs(m.avgMs)) +
        (hasAvg ? '<span class="c2m-recbar' + (avg >= 10000 ? " slow" : "") + '"><i style="width:' + avgPct +
          '%"></i></span>' : "") + "</span></td>" +
        '<td><div class="c2m-mwhos">' + chips + "</div></td>";
      var sig = [calls, m.errors, m.inTokens, m.outTokens, m.avgMs, avgPct,
        who.map(function (c) { return callerName(c) + m.byCaller[c]; }).join(",")].join("|");
      return '<tr data-k="' + esc("m:" + model) + '" data-s="' + esc(sig) + '">' + cells + "</tr>";
    });
    if (list.length > 12) {
      rows.push('<tr class="c2m-mmore" data-k="m:+more" data-s="' + (list.length - 12) + '"><td colspan="5">另有 ' +
        (list.length - 12) + " 个模型调用较少，未列出</td></tr>");
    }
    return rows.join("");
  }

  function modelHtml(r) {
    var body = modelRows(r);
    if (!body) return '<div class="c2d-empty">暂无数据</div>';
    return '<table class="c2d-tbl c2m-modeltbl"><thead><tr><th>模型</th><th class="num">调用</th>' +
      '<th class="num">token</th><th class="num">平均耗时</th><th>谁在调</th></tr></thead>' +
      "<tbody>" + body + "</tbody></table>";
  }

  function detailRow(x, maxMs, key) {
    var bad = Number(x.status) >= 400;
    var isNew = Boolean(state.auto.fresh[recKey(x)]);
    var model = String(x.model || "");
    var cut = model.indexOf("/");
    var prov = cut > 0 ? model.slice(0, cut) : "";
    var short = cut > 0 ? model.slice(cut + 1) : model;
    var master = x.caller === "master";
    var who = master ? "超管" : (x.name || x.caller || "—");
    var whoSub = master ? "上游网关主 key" : (x.name ? x.caller : "");
    var ms = Number(x.ms);
    var hasMs = x.ms != null && isFinite(ms);
    var pct = hasMs && maxMs > 0 ? Math.max(2, Math.round((ms / maxMs) * 100)) : 0;
    var barCls = bad ? " bad" : hasMs && ms >= 10000 ? " slow" : "";
    var outTok = bad && !Number(x.out_tokens) ? "—" : fmtTokens(x.out_tokens);
    var inTok = x.in_tokens == null ? "—" : fmtTokens(x.in_tokens);
    var result = bad
      ? '<span class="c2m-recbad"><span class="c2m-badge bad">' + esc(x.status) + "</span>" +
        '<span class="c2m-recwhy" title="' + esc(x.error_code || statusReason(x)) + '">' + esc(statusReason(x)) + "</span></span>"
      : '<span class="c2m-recok" title="HTTP ' + esc(x.status) + '">✓ 成功</span>';
    return '<tr class="c2m-recrow' + (bad ? " bad" : "") + (isNew ? " fresh" : "") + '" data-k="' + esc(key) +
      '" data-s="' + (isNew ? "n" : "o") + pct + '">' +
      '<td class="c-time"><span class="c2m-rectime">' + esc(hhmmss(x.ts)) + "</span>" +
      (isNew ? '<span class="c2m-recnew">新</span>' : "") + "</td>" +
      '<td class="c-who"><span class="c2m-recwho" title="' + esc(who) + '">' + esc(who) + "</span>" +
      (whoSub ? '<span class="c2m-recsub">' + esc(whoSub) + "</span>" : "") + "</td>" +
      '<td class="c-model"><span class="c2m-recmodel" title="' + esc(model) + '">' +
      (prov ? '<span class="c2m-recprov">' + esc(prov) + " / </span>" : "") + esc(short) + "</span></td>" +
      '<td class="c-res">' + result + "</td>" +
      '<td class="c-ms num" data-l="耗时"><span class="c2m-recms">' + esc(fmtMs(x.ms)) +
      (hasMs ? '<span class="c2m-recbar' + barCls + '"><i style="width:' + pct + '%"></i></span>' : "") + "</span></td>" +
      '<td class="c-in num" data-l="输入"><span class="c2m-rectok">' + esc(inTok) + "</span></td>" +
      '<td class="c-out num" data-l="输出"><span class="c2m-rectok">' + esc(outTok) + "</span></td>" +
      '<td class="c-way"><span class="c2m-recway' + (x.stream ? " stream" : "") + '">' +
      (x.stream ? "流式" : "一次性") + "</span></td></tr>";
  }

  function detailRows(r) {
    var rows = r.rows || [];
    var maxMs = rows.reduce(function (m, x) {
      var v = Number(x.ms);
      return x.ms != null && isFinite(v) && v > m ? v : m;
    }, 0);
    var out = [];
    var lastDay = null;
    var seen = {};
    rows.forEach(function (x) {
      var day = localDay(x.ts) || x.day || "";
      if (day !== lastDay) {
        out.push('<tr class="c2m-recday" data-k="' + esc("d:" + day) + '" data-s="' + esc(dayHead(day)) + '">' +
          '<td colspan="8">' + esc(dayHead(day)) + "</td></tr>");
        lastDay = day;
      }
      var base = recKey(x);
      seen[base] = (seen[base] || 0) + 1;
      out.push(detailRow(x, maxMs, seen[base] > 1 ? base + "#" + seen[base] : base));
    });
    return out.join("");
  }

  function detailHtml(r) {
    var body = detailRows(r);
    if (!body) return '<div class="c2d-empty">所选日期内没有调用记录</div>';
    return '<table class="c2d-tbl c2m-rectbl"><thead><tr><th>时间</th><th>调用方</th><th>模型</th><th>结果</th>' +
      '<th class="num">耗时</th><th class="num">输入</th><th class="num">输出</th><th>方式</th></tr></thead>' +
      "<tbody>" + body + "</tbody></table>";
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
    updateAutoUi();
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

  async function fetchRecords(q) {
    var res = await call({
      action: "records",
      days: q.days,
      filter: q.filter,
      limit: 300,
    });
    /* 把本次见到的模型并入候选全集（只增不减）：这样按某个模型筛选后，
       下拉里其它模型仍在，用户能直接切回去。 */
    var seen = state.modelCandidates;
    (res.byModel || []).forEach(function (m) {
      if (m && m.model && seen.indexOf(m.model) < 0) seen.push(m.model);
    });
    return res;
  }

  async function loadRecords() {
    var q = snapshotQuery();
    var res = await fetchRecords(q);
    if (q.days.length === 0 && Array.isArray(res.days)) {
      q.days = res.days.slice();
      if ((state.days || []).length === 0) state.days = res.days.slice();
    }
    state.records = res;
    state.query = q;
    state.auto.fresh = {};
    state.auto.err = "";
    state.auto.lastAt = Date.now();
  }

  function autoBlock() {
    if (!state.auto.on) return "off";
    if (state.daysOpen) return "days";
    if (dirty()) return "dirty";
    return "";
  }

  function canAuto() {
    return state.auto.visible && state.tab === "records" && !document.hidden &&
      Boolean(state.records) && Boolean(state.query) && !state.auto.busy && autoBlock() === "";
  }

  function updateAutoUi() {
    var box = overlay && overlay.querySelector("[data-rec-auto]");
    if (!box) return;
    var a = state.auto;
    var block = autoBlock();
    var text;
    var mode;
    if (block === "off") {
      text = "自动刷新已暂停";
      mode = "off";
    } else if (block === "days") {
      text = "正在选日期，自动刷新暂停";
      mode = "wait";
    } else if (block === "dirty") {
      text = "筛选已改动，点「查询」后继续自动刷新";
      mode = "wait";
    } else if (a.busy) {
      text = "正在刷新…";
      mode = "on";
    } else if (a.err) {
      text = "刷新失败：" + a.err + "，稍后自动重试";
      mode = "err";
    } else {
      var s = a.lastAt ? Math.max(0, Math.round((Date.now() - a.lastAt) / 1000)) : 0;
      text = "每 " + Math.max(1, Math.round(autoMs() / 1000)) + " 秒自动刷新 · " +
        (s < 2 ? "刚刚更新" : s + " 秒前更新");
      mode = "on";
    }
    box.setAttribute("data-mode", mode);
    var t = box.querySelector("[data-rec-autotext]");
    if (t && t.textContent !== text) t.textContent = text;
    var b = box.querySelector('[data-act="rec-auto"]');
    var label = a.on ? "暂停" : "继续";
    if (b && b.textContent !== label) b.textContent = label;
  }

  function rowTop(row, pane) {
    return row.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  }

  function findAnchor(pane) {
    if (pane.scrollTop <= 0) return null;
    var rows = pane.querySelectorAll("tr[data-k]");
    for (var i = 0; i < rows.length; i++) {
      var top = rowTop(rows[i], pane);
      if (top + rows[i].getBoundingClientRect().height > 0) {
        return { key: rows[i].getAttribute("data-k"), offset: top };
      }
    }
    return null;
  }

  function restoreAnchor(pane, anchor) {
    if (!anchor) return;
    var row = Array.prototype.filter.call(pane.querySelectorAll("tr[data-k]"), function (el) {
      return el.getAttribute("data-k") === anchor.key;
    })[0];
    if (row) pane.scrollTop = pane.scrollTop + (rowTop(row, pane) - anchor.offset);
  }

  function reconcile(tbody, rowsHtml) {
    var tpl = document.createElement("tbody");
    tpl.innerHTML = rowsHtml;
    var incoming = Array.prototype.slice.call(tpl.children);
    var want = {};
    incoming.forEach(function (el) { want[el.getAttribute("data-k")] = true; });
    var have = {};
    Array.prototype.slice.call(tbody.children).forEach(function (el) {
      var k = el.getAttribute("data-k");
      if (k && want[k] && !have[k]) have[k] = el;
      else tbody.removeChild(el);
    });
    incoming.forEach(function (el, i) {
      var k = el.getAttribute("data-k");
      var node = have[k];
      if (node && node.getAttribute("data-s") !== el.getAttribute("data-s")) {
        tbody.replaceChild(el, node);
        node = el;
      }
      if (!node) node = el;
      var ref = tbody.children[i];
      if (ref !== node) tbody.insertBefore(node, ref || null);
    });
  }

  function syncPane(kind, rowsHtml, fullHtml) {
    var pane = overlay && overlay.querySelector('[data-rec-pane="' + kind + '"]');
    if (!pane) return;
    var anchor = findAnchor(pane);
    var tbody = pane.querySelector("tbody");
    if (tbody && rowsHtml) {
      reconcile(tbody, rowsHtml);
    } else {
      var keep = pane.scrollTop;
      pane.innerHTML = fullHtml;
      pane.scrollTop = keep;
    }
    restoreAnchor(pane, anchor);
  }

  function setText(selector, text) {
    var el = overlay && overlay.querySelector(selector);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function syncRecords() {
    var r = state.records;
    if (!overlay || !r) return;
    syncPane("model", modelRows(r), modelHtml(r));
    syncPane("detail", detailRows(r), detailHtml(r));
    setText('[data-rec-title="model"]', modelTitle(r));
    setText('[data-rec-title="detail"]', detailTitle(r));
  }

  function recordsSig(r) {
    var rows = (r && r.rows) || [];
    return [
      r && r.total,
      r && r.shown,
      rows.length ? recKey(rows[0]) : "",
      rows.length ? recKey(rows[rows.length - 1]) : "",
      ((r && r.byModel) || []).map(function (m) { return m.model + ":" + m.calls + ":" + m.errors; }).join(","),
    ].join("~");
  }

  async function autoTick() {
    updateAutoUi();
    if (!canAuto() || Date.now() - state.auto.lastAt < autoMs()) return;
    var q = state.query;
    state.auto.busy = true;
    updateAutoUi();
    try {
      var res = await fetchRecords(q);
      if (q !== state.query) return;
      state.auto.err = "";
      if (recordsSig(res) === recordsSig(state.records)) {
        state.records = res;
        return;
      }
      var before = {};
      ((state.records && state.records.rows) || []).forEach(function (x) { before[recKey(x)] = 1; });
      var fresh = {};
      (res.rows || []).forEach(function (x) {
        var k = recKey(x);
        if (!before[k]) fresh[k] = 1;
      });
      state.records = res;
      state.auto.fresh = fresh;
      if (state.tab === "records") syncRecords();
    } catch (err) {
      state.auto.err = (err && err.message) || String(err);
    } finally {
      state.auto.busy = false;
      state.auto.lastAt = Date.now();
      updateAutoUi();
    }
  }

  function startAuto() {
    stopAuto();
    state.auto.visible = true;
    state.auto.timer = setInterval(autoTick, Math.min(1000, autoMs()));
  }

  function stopAuto() {
    state.auto.visible = false;
    if (state.auto.timer) {
      clearInterval(state.auto.timer);
      state.auto.timer = null;
    }
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
      '<div role="dialog" aria-modal="true" class="dim-jh-modal c2m-scope" data-scope="c2m" style="width:min(520px,calc(100vw - 24px))">' +
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
      } else if (act === "rec-auto") {
        state.auto.on = !state.auto.on;
        writeAutoOn(state.auto.on);
        if (state.auto.on) state.auto.lastAt = 0;
        updateAutoUi();
        if (state.auto.on) autoTick();
      }
    } catch (err) {
      alert(err.message);
    }
  }

  /* ── 弹窗骨架（复用原生 .dim-jh-modal*）──────────────────────────── */

  function build() {
    var ov = document.createElement("div");
    ov.className = "c2-page";
    ov.innerHTML =
      '<div class="c2-pageHead">' +
      "<div>" +
      '<h1 class="c2-pageTitle">调用方</h1>' +
      '<p class="c2-pageSub"><span id="c2m-sub">加载中…</span> · 分组决定能用哪些模型，Key 决定谁在调；' +
      "用量与调用记录按 Key / 模型实时汇总，超管 Key 一并统计。</p>" +
      "</div>" +
      '<div class="c2-pageActions"><button type="button" class="c2-btn" id="c2m-refresh">刷新</button></div>' +
      "</div>" +
      '<div class="c2m-scope c2d-body" id="c2m-body">加载中…</div>';

    ov.addEventListener("click", function (e) {
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
        updateAutoUi();
      }
    });

    ov.querySelector("#c2m-refresh").addEventListener("click", function () {
      state.records = null;
      refresh();
    });
    return ov;
  }

  function mount(container) {
    ensureStyle();
    overlay = build();
    container.appendChild(overlay);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state.auto.visible) autoTick();
    });
  }

  function onHide() {
    stopAuto();
  }

  function onShow() {
    if (!overlay) return;
    // 有上次的快照就先把内容画出来（毫秒级），随后 refresh 再更新 ——
    // 否则用户点开后要盯着「加载中…」等 state 请求（冷启动可达 1s）。
    if (state.cached && !state.data) {
      state.data = state.cached;
      repaint();
    }
    refresh();
    startAuto();
  }

  if (window.__c2Shell) {
    window.__c2Shell.registerView("callers", { mount: mount, onShow: onShow, onHide: onHide });
  } else {
    console.error("[callers-ui] 外壳 admin-shell.js 未加载，调用方无处挂载");
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

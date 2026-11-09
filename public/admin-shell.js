;(function () {
  "use strict"
  if (window.__c2Shell) return

  var THEME_KEY = "c2-theme"
  var THEMES = [
    { id: "auto", label: "跟随系统", icon: "◐" },
    { id: "light", label: "浅色", icon: "☀" },
    { id: "dark", label: "深色", icon: "☾" },
  ]

  function readTheme() {
    try {
      var value = window.localStorage.getItem(THEME_KEY)
      return value === "light" || value === "dark" ? value : "auto"
    } catch {
      return "auto"
    }
  }

  function applyTheme(theme) {
    var root = document.documentElement
    if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme)
    else root.removeAttribute("data-theme")
  }

  function saveTheme(theme) {
    try {
      if (theme === "auto") window.localStorage.removeItem(THEME_KEY)
      else window.localStorage.setItem(THEME_KEY, theme)
    } catch {
      return
    }
  }

  applyTheme(readTheme())

  function measureGutter() {
    var supported = window.CSS && CSS.supports && CSS.supports("scrollbar-gutter", "stable")
    var width = 0
    if (supported && document.body) {
      var probe = document.createElement("div")
      probe.style.cssText = "position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll"
      document.body.appendChild(probe)
      width = probe.offsetWidth - probe.clientWidth
      document.body.removeChild(probe)
    }
    document.documentElement.style.setProperty("--c2-gutter", width + "px")
  }

  var gutterFrame = 0
  window.addEventListener("resize", function () {
    if (gutterFrame) return
    gutterFrame = window.requestAnimationFrame(function () {
      gutterFrame = 0
      measureGutter()
    })
  })

  var NAV = [
    { id: "overview", label: "总览", title: "网关状态、今日用量、趋势、渠道余额、积分收支、模型分布、自动签到" },
    { id: "channels", label: "渠道管理", title: "各渠道账号、聚合路由、网关、备份与恢复" },
    { id: "callers", label: "调用方", title: "分组白名单、分发 Key、按 Key / 模型的用量与调用记录" },
  ]
  var DEFAULT_VIEW = "overview"

  var views = {}
  var current = null
  var ready = false

  function viewEl(id) {
    return document.querySelector('[data-view="' + id + '"]')
  }

  function routeFromHash() {
    var id = String(window.location.hash || "").replace(/^#\/?/, "")
    for (var i = 0; i < NAV.length; i++) if (NAV[i].id === id) return id
    return DEFAULT_VIEW
  }

  function show(id) {
    if (!ready) return
    if (current === id) {
      ensureMounted(id)
      return
    }
    var previous = current
    current = id
    document.documentElement.setAttribute("data-c2-view", id)
    for (var i = 0; i < NAV.length; i++) {
      var item = NAV[i]
      var el = viewEl(item.id)
      if (el) el.hidden = item.id !== id
      var tab = document.querySelector('[data-nav="' + item.id + '"]')
      if (tab) {
        tab.setAttribute("aria-selected", item.id === id ? "true" : "false")
        tab.tabIndex = item.id === id ? 0 : -1
      }
    }
    if (previous && views[previous] && views[previous].mounted && views[previous].onHide) {
      safe(views[previous].onHide)
    }
    ensureMounted(id)
    var label = NAV.filter(function (n) {
      return n.id === id
    })[0]
    document.title = (label ? label.label + " · " : "") + "codearts2api"
  }

  function ensureMounted(id) {
    var view = views[id]
    var el = viewEl(id)
    if (!view || !el) return
    if (!view.mounted) {
      view.mounted = true
      safe(function () {
        view.mount(el)
      })
    }
    if (view.onShow) safe(view.onShow)
  }

  function safe(fn) {
    try {
      fn()
    } catch (error) {
      console.error("[admin-shell]", error)
    }
  }

  function go(id) {
    if ("#" + id === window.location.hash) show(id)
    else window.location.hash = id
  }

  function registerView(id, view) {
    views[id] = { mount: view.mount, onShow: view.onShow, onHide: view.onHide, mounted: false }
    if (ready && current === id) ensureMounted(id)
  }

  var pendingActions = []

  function registerAction(action) {
    if (!ready) {
      pendingActions.push(action)
      return
    }
    var host = document.getElementById("c2-actions")
    var anchor = document.getElementById("c2-theme")
    if (!host || document.querySelector('[data-action="' + action.id + '"]')) return
    var btn = document.createElement("button")
    btn.type = "button"
    btn.className = "c2-btn"
    btn.setAttribute("data-action", action.id)
    if (action.title) btn.title = action.title
    btn.setAttribute("aria-label", action.label)
    if (action.icon) {
      var icon = document.createElement("span")
      icon.setAttribute("aria-hidden", "true")
      icon.textContent = action.icon
      btn.appendChild(icon)
    }
    var text = document.createElement("span")
    text.className = "c2-actionLabel"
    text.textContent = action.label
    btn.appendChild(text)
    btn.addEventListener("click", function () {
      safe(action.onClick)
    })
    host.insertBefore(btn, anchor || null)
  }

  var modalStack = []

  function openModal(options) {
    var opener = document.activeElement
    var overlay = document.createElement("div")
    overlay.className = "c2-overlay"
    var dialog = document.createElement("div")
    dialog.className = "c2-modal" + (options.wide ? " c2-modal--wide" : "")
    dialog.setAttribute("role", "dialog")
    dialog.setAttribute("aria-modal", "true")
    var titleId = "c2-modal-title-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    dialog.setAttribute("aria-labelledby", titleId)

    var head = document.createElement("div")
    head.className = "c2-modalHead"
    var title = document.createElement("h2")
    title.className = "c2-modalTitle"
    title.id = titleId
    title.textContent = options.title
    if (options.subtitle) {
      var sub = document.createElement("span")
      sub.className = "c2-modalSub"
      sub.textContent = options.subtitle
      title.appendChild(sub)
    }
    var closeBtn = document.createElement("button")
    closeBtn.type = "button"
    closeBtn.className = "c2-btn c2-btn--ghost c2-iconBtn"
    closeBtn.setAttribute("aria-label", "关闭")
    closeBtn.textContent = "✕"
    head.appendChild(title)
    head.appendChild(closeBtn)

    var body = document.createElement("div")
    body.className = "c2-modalBody"
    if (typeof options.body === "string") body.textContent = options.body
    else if (options.body) body.appendChild(options.body)

    dialog.appendChild(head)
    dialog.appendChild(body)
    if (options.footer && options.footer.length > 0) {
      var foot = document.createElement("div")
      foot.className = "c2-modalFoot"
      for (var i = 0; i < options.footer.length; i++) foot.appendChild(options.footer[i])
      dialog.appendChild(foot)
    }
    overlay.appendChild(dialog)

    var closed = false
    var handle = {
      root: dialog,
      body: body,
      close: function () {
        if (closed) return
        closed = true
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        modalStack = modalStack.filter(function (m) {
          return m !== handle
        })
        if (options.onClose) safe(options.onClose)
        if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus()
      },
    }

    closeBtn.addEventListener("click", handle.close)
    var downOnOverlay = false
    overlay.addEventListener("mousedown", function (e) {
      downOnOverlay = e.target === overlay
    })
    overlay.addEventListener("click", function (e) {
      if (downOnOverlay && e.target === overlay) handle.close()
      downOnOverlay = false
    })

    document.body.appendChild(overlay)
    modalStack.push(handle)

    var focusTarget =
      (options.initialFocus && body.querySelector(options.initialFocus)) || firstFocusable(dialog) || closeBtn
    if (focusTarget) focusTarget.focus()
    return handle
  }

  function firstFocusable(root) {
    return root.querySelector(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]):not([aria-label="关闭"]), [href]',
    )
  }

  function focusables(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll('input, textarea, select, button, [href], [tabindex]:not([tabindex="-1"])'),
      function (el) {
        return !el.disabled && el.offsetParent !== null
      },
    )
  }

  document.addEventListener(
    "keydown",
    function (e) {
      var top = modalStack[modalStack.length - 1]
      if (!top) return
      if (e.key === "Escape") {
        e.stopPropagation()
        top.close()
        return
      }
      if (e.key === "Tab") {
        var list = focusables(top.root)
        if (list.length === 0) return
        var first = list[0]
        var last = list[list.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    },
    true,
  )

  function themeIcon(theme) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === theme) return THEMES[i].icon
    return "◐"
  }

  function wireTheme() {
    var btn = document.getElementById("c2-theme")
    if (!btn) return
    var menu = null

    function sync() {
      var theme = readTheme()
      btn.textContent = themeIcon(theme)
      var label = THEMES.filter(function (t) {
        return t.id === theme
      })[0]
      btn.title = "主题：" + (label ? label.label : "跟随系统")
    }

    function closeMenu() {
      if (menu && menu.parentNode) menu.parentNode.removeChild(menu)
      menu = null
      btn.setAttribute("aria-expanded", "false")
      document.removeEventListener("mousedown", onOutside, true)
    }

    function onOutside(e) {
      if (menu && !menu.contains(e.target) && e.target !== btn) closeMenu()
    }

    btn.addEventListener("click", function () {
      if (menu) {
        closeMenu()
        return
      }
      menu = document.createElement("div")
      menu.className = "c2-menu"
      menu.setAttribute("role", "menu")
      var currentTheme = readTheme()
      THEMES.forEach(function (t) {
        var item = document.createElement("button")
        item.type = "button"
        item.className = "c2-menuItem"
        item.setAttribute("role", "menuitemradio")
        item.setAttribute("aria-checked", t.id === currentTheme ? "true" : "false")
        item.textContent = t.icon + "  " + t.label
        item.addEventListener("click", function () {
          saveTheme(t.id)
          applyTheme(t.id)
          sync()
          closeMenu()
          btn.focus()
        })
        menu.appendChild(item)
      })
      btn.parentNode.appendChild(menu)
      btn.setAttribute("aria-expanded", "true")
      var checked = menu.querySelector('[aria-checked="true"]')
      if (checked) checked.focus()
      document.addEventListener("mousedown", onOutside, true)
    })

    menuKeys(
      btn,
      function () {
        return menu
      },
      closeMenu,
    )
    sync()
  }

  function menuKeys(btn, getMenu, closeMenu) {
    document.addEventListener("keydown", function (e) {
      var menu = getMenu()
      if (!menu) return
      if (e.key === "Escape") {
        closeMenu()
        btn.focus()
        return
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        var items = Array.prototype.slice.call(menu.querySelectorAll(".c2-menuItem"))
        var at = items.indexOf(document.activeElement)
        var next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length
        items[next].focus()
        e.preventDefault()
      }
    })
  }

  function wireNav() {
    var nav = document.getElementById("c2-nav")
    if (!nav) return
    NAV.forEach(function (item) {
      var tab = document.createElement("button")
      tab.type = "button"
      tab.className = "c2-navItem"
      tab.setAttribute("role", "tab")
      tab.setAttribute("data-nav", item.id)
      tab.setAttribute("aria-controls", "c2-view-" + item.id)
      tab.setAttribute("aria-selected", "false")
      tab.title = item.title
      tab.textContent = item.label
      tab.addEventListener("click", function () {
        go(item.id)
      })
      nav.appendChild(tab)
    })
    nav.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
      var at = NAV.map(function (n) {
        return n.id
      }).indexOf(current)
      var next = e.key === "ArrowRight" ? (at + 1) % NAV.length : (at - 1 + NAV.length) % NAV.length
      go(NAV[next].id)
      var tab = document.querySelector('[data-nav="' + NAV[next].id + '"]')
      if (tab) tab.focus()
      e.preventDefault()
    })
    window.addEventListener("hashchange", function () {
      show(routeFromHash())
    })
  }

  function wireLogout() {
    var logout = document.getElementById("c2-logout")
    if (!logout || typeof fetch !== "function") return
    fetch("/healthz", { headers: { accept: "application/json" } })
      .then(function (res) {
        return res.ok ? res.json() : null
      })
      .then(function (data) {
        if (data && data.adminAuth === false) logout.hidden = true
      })
      .catch(function () {})
  }

  function boot() {
    ready = true
    measureGutter()
    wireNav()
    wireTheme()
    wireLogout()
    var queued = pendingActions
    pendingActions = []
    queued.forEach(registerAction)
    show(routeFromHash())
  }

  window.__c2Shell = {
    registerView: registerView,
    registerAction: registerAction,
    openModal: openModal,
    go: go,
    current: function () {
      return current
    },
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot)
  else boot()
})()

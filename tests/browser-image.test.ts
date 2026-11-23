/**
 * 「带浏览器」镜像的**契约**测试。
 *
 * ## 为什么这类东西要测
 *
 * 浏览器版镜像不是本仓的主路径：它只在需要豆包扫码登录 / 签到 / zcode captcha 的部署里
 * 用得上，平时没人跑。**没有守卫的话，任何一次「顺手清理」都会把它悄悄弄坏** ——
 * 典型三种：
 *
 * 1. 有人把 `docker/c2a-chromium` 从 `COPY` 列表里删掉 ⇒ 构建通过、运行时 `/usr/bin/chromium`
 *    变成空/旧文件 ⇒ 症状是「浏览器起不来」，且与「没装浏览器」长得一模一样；
 * 2. 有人把包装器里的 `id -u` 判据改成无条件 `--no-sandbox`（或反过来删掉）⇒
 *    前者悄悄削弱隔离，后者让 root 场景重新回到 100% 失败；
 * 3. 有人把入口脚本的 `exec node` 改成 `node`（丢了 exec）⇒ 容器收不到 SIGTERM，
 *    退出时留下孤儿 chromium（`src/index.ts` 头部注释记录过这个后果）。
 *
 * 这些都是**读文件即可判定**的事实，故这里做静态契约断言；真实的
 * `docker build` / 起容器在 CI 里成本太高（浏览器版不是发布产物），不在本测试里做。
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "vite-plus/test"

const root = join(import.meta.dirname, "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

const DOCKERFILE = read("Dockerfile.browser")
const WRAPPER = read("docker/c2a-chromium")
const ENTRY = read("docker/c2a-browser-entry.sh")

test("浏览器镜像装齐四件套：chromium / 字体 / Xvfb / x11vnc", () => {
  // 只取 apt 安装那一段：`chromium` 这个词在文件其他位置（路径、注释）也出现，
  // 全局搜索会得到「装过」的假象（本仓记录过多次这种假绿）。
  const installBlock = DOCKERFILE.match(/apt-get install[\s\S]*?rm -rf \/var\/lib\/apt\/lists/)![0]
  for (const pkg of ["chromium", "fonts-noto-cjk", "xvfb", "x11vnc"]) {
    assert.match(
      installBlock,
      new RegExp(`\\b${pkg}\\b`),
      `Dockerfile.browser 的 apt 安装段没有 ${pkg} —— 少任何一个都会让对应链路静默失败`,
    )
  }
})

test("包装器占住 /usr/bin/chromium，并保留真实二进制的退路", () => {
  // ⚠️ 这两条是一对：少了 mv 就没有真实二进制（自引用），少了 COPY 就没有判据。
  assert.match(DOCKERFILE, /mv \/usr\/lib\/chromium\/chromium \/usr\/lib\/chromium\/chromium\.real/)
  assert.match(DOCKERFILE, /COPY docker\/c2a-chromium \/usr\/bin\/chromium/)
  assert.match(WRAPPER, /REAL=\/usr\/lib\/chromium\/chromium\.real/)
})

test("root 判据按运行时取，而不是无条件 --no-sandbox", () => {
  assert.match(WRAPPER, /id -u/, "包装器丢了 root 判据 ⇒ 非 root 部署也被削弱隔离")
  assert.match(WRAPPER, /--no-sandbox/)
  // 无条件加的形态：`EXTRA="--no-sandbox"` 出现在 if 之外 —— 这里用「if 与赋值同段」的正向断言守住。
  assert.match(WRAPPER, /if \[ "\$\(id -u\)" = "0" \]; then[\s\S]*--no-sandbox/)
})

test("小 /dev/shm 时补 --disable-dev-shm-usage（阈值 512MB）", () => {
  assert.match(WRAPPER, /df -k \/dev\/shm/, "读不到 /dev/shm 可用空间 ⇒ Docker 默认 64MB 场景必崩")
  assert.match(WRAPPER, /524288/, "阈值必须是 512MB（KB 口径）")
  assert.match(WRAPPER, /--disable-dev-shm-usage/)
})

test("入口脚本：无 DISPLAY 时起 Xvfb，且最终 exec 进程本体", () => {
  assert.match(ENTRY, /if \[ -z "\$\{DISPLAY:-\}" \]; then/, "没有 DISPLAY 判据 ⇒ 覆盖用户自带的 X")
  assert.match(ENTRY, /Xvfb :99/, "headful 链路需要虚拟屏")
  assert.match(ENTRY, /export DISPLAY=:99/)
  assert.match(ENTRY, /exec node dist-server\/index\.js/, "丢了 exec ⇒ 容器收不到 SIGTERM（孤儿 chromium）")
})

test("README 给出浏览器镜像的构建与运行方式（含 VNC 与安全提示）", () => {
  const readme = read("README.md")
  assert.match(readme, /Dockerfile\.browser/)
  assert.match(readme, /C2A_VNC=1/)
  assert.match(readme, /5900/)
  // 安全提示不能删：这个端口没有密码。
  assert.match(readme, /不设密码|可信内网/)
})

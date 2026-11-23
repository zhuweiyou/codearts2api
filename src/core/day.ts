/**
 * 日期键：本项目全部「按天」统计统一走 **UTC+8**。
 *
 * 为什么必须集中一处：用量日志的**写入**（`usage-recorder`）、总览的**读取**
 * （`dashboard`）、调用方页的**读取**（`callers`）三处各算各的，只要有一处用
 * 服务器本地时区，就会在非 UTC+8 的机器上（Docker 镜像默认 UTC）读到空文件。
 * 实测症状：北京时间 00:00-08:00 期间总览「今日请求」恒为 0，而同一天的
 * `token-ledger.json`（上游按 UTC+8 记）却有数据 —— 卡片一半有数一半是 0。
 */
export function utc8Day(date: Date = new Date()): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

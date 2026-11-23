/** @vitest-environment jsdom */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"

import { cleanup, render, screen, within } from "@testing-library/react"
import { test, vi } from "vite-plus/test"

import { createUsageRecorder } from "../src/modules/caller-gate/usage-recorder.service.ts"
import { createCallersService } from "../src/modules/callers/callers.service.ts"
import { RecordsTab } from "../web/pages/callers/RecordsTab.tsx"

test("逐条明细显示各协议实际命中率，旧记录和未上报显示 —", async () => {
  const home = await mkdtemp(join(tmpdir(), "c2a-cache-records-"))
  const recorder = createUsageRecorder({ logDir: join(home, "caller-usage") })
  const chat = { prompt_tokens: 100, completion_tokens: 2 }
  const responses = { input_tokens: 200, output_tokens: 2 }
  const cases = [
    ["chat-json", "chat/completions", false, { usage: { ...chat, prompt_cache_hit_tokens: 40 } }, 40, "40%"],
    [
      "chat-zero",
      "chat/completions",
      true,
      { usage: { ...chat, prompt_tokens_details: { cached_tokens: 0 } } },
      0,
      "0%",
    ],
    ["chat-unreported", "chat/completions", true, { usage: chat }, null, "—"],
    [
      "responses-json",
      "responses",
      false,
      { usage: { ...responses, input_tokens_details: { cached_tokens: 0 }, cache_read_reported: false } },
      null,
      "—",
    ],
    [
      "responses-sse",
      "responses",
      true,
      {
        type: "response.completed",
        response: { usage: { ...responses, input_tokens_details: { cached_tokens: 75 } } },
      },
      75,
      "37.5%",
    ],
    [
      "responses-incomplete",
      "responses",
      true,
      {
        type: "response.incomplete",
        response: { usage: { ...responses, input_tokens_details: { cached_tokens: 200 } } },
      },
      200,
      "100%",
    ],
    [
      "invalid-count",
      "chat/completions",
      false,
      { usage: { ...chat, prompt_tokens_details: { cached_tokens: 101 } } },
      null,
      "—",
    ],
  ] as const

  try {
    for (const [model, route, stream, payload] of cases) {
      const json = JSON.stringify(payload)
      const wire = stream ? `data: ${json}\r\n\r\n` : json
      const cut = Math.floor(wire.length / 2)
      const source = Readable.from([Buffer.from(wire.slice(0, cut)), Buffer.from(wire.slice(cut))])
      const chunks: Buffer[] = []
      for await (const chunk of recorder.tapStream(source, { model, path: `/v1/${route}`, stream })) {
        chunks.push(chunk)
      }
      assert.equal(Buffer.concat(chunks).toString("utf8"), wire)
    }
    await recorder.log({ ts: new Date().toISOString(), model: "legacy-record", status: 200, in_tokens: 100 })
    const records = await createCallersService({ home }).records()
    for (const [model, , , , cached] of cases) {
      assert.equal(records.rows.find((row) => row.model === model)?.cached_tokens, cached, model)
    }
    render(
      <RecordsTab
        data={null}
        records={records}
        filter={{ caller: "", model: "", status: "" }}
        setFilter={vi.fn()}
        days={[]}
        daysOpen={false}
        setDaysOpen={vi.fn()}
        toggleDay={vi.fn()}
        applyPreset={vi.fn()}
        applyQuery={vi.fn()}
        autoOn={false}
        toggleAuto={vi.fn()}
        autoBusy={false}
        autoErr=""
        lastAt={0}
        fresh={{}}
        autoBlock={() => "off"}
        modelCandidates={[]}
      />,
    )

    const detail = screen.getByRole("columnheader", { name: "输入" }).closest("table")!
    const hit = (model: string, text: string) => {
      const row = within(detail).getByRole("row", { name: new RegExp(model) })
      return within(row).getByText(`命中 ${text}`)
    }
    for (const [model, , , , , rate] of cases) hit(model, rate)
    assert.equal(hit("legacy-record", "—").title, "未上报可用的缓存数据")
    assert.equal(hit("responses-sse", "37.5%").title, "缓存命中 75 / 输入 200 Token")
  } finally {
    cleanup()
    await rm(home, { recursive: true, force: true })
  }
})

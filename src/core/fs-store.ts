/** 文件存储小工具：容错读 JSON/JSONL、原子写 JSON。 */
import { readFile, rename, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"

export async function readJson(file: string): Promise<any> {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

export async function readJsonl(file: string): Promise<any[]> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch {
    return []
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
    .filter(Boolean) as any[]
}

export async function writeJsonAtomic(file: string, data: any): Promise<void> {
  const text = JSON.stringify(data, null, 2) + "\n"
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
  await writeFile(tmp, text, { mode: 0o600 })
  await rename(tmp, file)
}

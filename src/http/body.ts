/** 请求体读取（带上限）。登录表单用更小的上限。 */

/** 请求体上限，与插件网关同值（16MB）。 */
export const BODY_LIMIT = 16 * 1024 * 1024

/** 把 node req 读成 Buffer（带上限，超限即断）。 */
export function readBody(request: any, limit = BODY_LIMIT): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("request body too large"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("error", reject)
    request.on("end", () => resolve(Buffer.concat(chunks)))
  })
}

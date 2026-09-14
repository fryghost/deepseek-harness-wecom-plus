import fs from "node:fs"
import zlib from "node:zlib"
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
function frames(buf) {
  const out = []
  let i = buf.indexOf(MAGIC)
  while (i !== -1) {
    const n = buf.indexOf(MAGIC, i + 4)
    out.push(buf.slice(i, n === -1 ? buf.length : n))
    i = n
  }
  return out
}
const file = process.argv[2]
let out = ""
for (const fr of frames(fs.readFileSync(file))) {
  try { out += zlib.zstdDecompressSync(fr).toString("utf8") } catch {}
}
const lines = out.split(/\r?\n/).filter(Boolean)
console.log("LINES:", lines.length)
try { console.log("HEADER:", lines[0]) } catch {}
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  const time = new Date(e.time).toLocaleTimeString("zh-CN")
  if (e.type === "system/message") {
    const txt = JSON.stringify(e.data?.message?.content ?? [])
    const m = txt.match(/workspace of this conversation is [^"\\]*/)
    if (m) console.log(time, "SYS:", m[0])
  } else if (e.type === "user/message") {
    const t = (e.data?.content ?? []).map(c => c.text ?? "").join("")
    console.log(time, "USER:", t.split("\n")[0].slice(0, 90))
  } else if (e.type === "assistant/message") {
    const c = e.data?.message?.content ?? []
    const t = c.map(x => x.text ?? "").join("")
    console.log(time, "ASSISTANT:", t.split("\n")[0].slice(0, 90))
  } else if (e.type === "turn/start" || e.type === "turn/end") {
    console.log(time, e.type.toUpperCase(), JSON.stringify(e.data ?? {}).slice(0, 120))
  }
}

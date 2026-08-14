/**
 * Wrap the compiled client entry into the browser module-loader format the
 * DSH Web frontend loads for bundles that declare `dsh.client`.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const compiledPath = join(root, '.client-build', 'client.cjs')
const outputPath = join(root, 'dist', 'client.js')

const source = await readFile(compiledPath, 'utf8')
const wrapped = [
  'window.__ModuleLoader__.load({ id: "deepseek-harness-wecom-plus", factory: (require) => {',
  'var module = { exports: {} }; var exports = module.exports;',
  source.replace(/\n?\/\/# sourceMappingURL=.*$/u, ''),
  'return module.exports; } });',
  '//# sourceMappingURL=client.js.map',
  '',
].join('\n')

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, wrapped)

const rawMap = JSON.parse(await readFile(`${compiledPath}.map`, 'utf8'))
rawMap.file = 'client.js'
rawMap.sources = rawMap.sources.map(sourcePath => `../src/client/${sourcePath.replace(/^\.\.\//u, '')}`)
await writeFile(`${outputPath}.map`, `${JSON.stringify(rawMap)}\n`)

await rm(join(root, '.client-build'), { recursive: true, force: true })

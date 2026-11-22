// 从权威矩阵逐行动态枚举；输出的是映射清单，绝不把源码出现编号当运行通过。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { enumerateMatrix, mapTestTitles } from './reflectionGate'
const root = resolve(__dirname, '../../..')
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(resolve(dir, e.name)) : [resolve(dir, e.name)])
}
const ids = enumerateMatrix(['history-matrix.md', 'reflection-matrix.md'].map(f => readFileSync(resolve(root, 'docs/research/1088', f), 'utf8')).join('\n'))
const mapping = mapTestTitles(ids, ['server/test', 'frontend/src'].flatMap(d => files(resolve(root, d))).filter(f => /(?:sessionsHistory|runnerHistory|reflections|reflection|runnerReflection)[^/]*\.test\.ts$/.test(f)).map(f => ({ path: relative(root, f), content: readFileSync(f, 'utf8') })))
const report = { status: 'mapping_only', source: '#1072 §4 + #1076 T2', entries: ids.map(id => ({ id, tests: mapping[id], evidence: [], status: 'not_verified' })), missing: ids.filter(id => !mapping[id].length) }
const output = process.argv[2]
if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
else console.log(JSON.stringify(report, null, 2))
if (report.missing.length) process.exitCode = 1

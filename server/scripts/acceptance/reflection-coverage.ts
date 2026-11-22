// 从权威矩阵逐行动态枚举；输出的是映射清单，绝不把源码出现编号当运行通过。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { resolve, relative } from 'node:path'
import { enumerateMatrix, mapTestTitles } from './reflectionGate'
const root = resolve(__dirname, '../../..')
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(resolve(dir, e.name)) : [resolve(dir, e.name)])
}
const ids = enumerateMatrix(['history-matrix.md', 'reflection-matrix.md'].map(f => readFileSync(resolve(root, 'docs/research/1088', f), 'utf8')).join('\n'))
const mapping = mapTestTitles(ids, ['server/test', 'frontend/src'].flatMap(d => files(resolve(root, d))).filter(f => /(?:sessionsHistory|runnerHistory|reflections|reflection|runnerReflection)[^/]*\.test\.ts$/.test(f)).map(f => ({ path: relative(root, f), content: readFileSync(f, 'utf8') })))
const resultSchema = z.object({ testResults: z.array(z.object({ name: z.string(), assertionResults: z.array(z.object({ title: z.string(), status: z.string() })) })) })
const reports = process.argv.slice(3).map(file => {
  const body = readFileSync(resolve(file), 'utf8')
  return { sha256: createHash('sha256').update(body).digest('hex'), ...resultSchema.parse(JSON.parse(body)) }
})
const entries = ids.map(id => {
  const tests = mapping[id]
  const evidence = tests.flatMap(test => reports.flatMap(report => report.testResults.filter(suite => relative(root, suite.name) === test.file).flatMap(suite => suite.assertionResults.filter(assertion => {
    const marker = test.title.search(/%[sdifjo]/)
    return marker < 0 ? assertion.title === test.title : assertion.title.startsWith(test.title.slice(0, marker))
  }).map(assertion => ({ reportSha256: report.sha256, file: test.file, template: test.title, title: assertion.title, status: assertion.status })))))
  const allObserved = tests.length > 0 && tests.every(test => evidence.some(e => e.file === test.file && e.template === test.title))
  const status = evidence.some(e => e.status === 'failed') ? 'failed' : allObserved && evidence.every(e => e.status === 'passed') ? 'passed' : 'not_verified'
  return { id, tests, evidence, status }
})
const report = { status: reports.length ? 'test_evidence_only' : 'mapping_only', source: '#1072 §4 + #1076 T2', entries, missing: ids.filter(id => !mapping[id].length), unverified: entries.filter(e => e.status !== 'passed').map(e => e.id) }

const output = process.argv[2]
if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
else console.log(JSON.stringify(report, null, 2))
if (report.missing.length || (reports.length > 0 && report.unverified.length > 0)) process.exitCode = 1

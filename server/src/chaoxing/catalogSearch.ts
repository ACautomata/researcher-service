import { ChaoxingConfigError, ChaoxingHttpError, type ChaoxingRemote, type ChaoxingQueryTarget, type LearningResult } from './remote'

export interface SyncedCourse { id: string; classId: string; name: string }

/** 每次查询固定一份课程快照，三个并发、45 秒总预算；局部失败必须在结果中说明。 */
export async function searchCourseCatalog(remote: ChaoxingRemote, token: string, catalog: SyncedCourse[], query: { topic: string; courseId?: string; classId?: string; target: ChaoxingQueryTarget; signal?: AbortSignal }): Promise<LearningResult> {
  if (query.classId && !query.courseId) throw new ChaoxingConfigError('请通过课程范围选择课程，班级参数不能单独使用')
  const courses = catalog.filter(course => !query.courseId || course.id === query.courseId)
  if (!courses.length) throw new ChaoxingConfigError('请先在账号设置同步课程清单，或重新选择已同步的课程')
  const deadline = AbortSignal.any([AbortSignal.timeout(45_000), ...(query.signal ? [query.signal] : [])])
  const results: Array<{ course: SyncedCourse; result?: LearningResult }> = []
  let next = 0
  let fatal: unknown
  async function worker() {
    while (!fatal && !deadline.aborted && next < courses.length) {
      const index = next++
      const course = courses[index]!
      try {
        const result = await remote.learn(token, query.topic, course.id, deadline, query.target, course.classId)
        results[index] = { course, result }
      } catch (error) {
        if (error instanceof ChaoxingHttpError && error.httpStatus === 401) { fatal = error; return }
        results[index] = { course }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, courses.length) }, worker))
  query.signal?.throwIfAborted()
  if (fatal) throw fatal
  const successful = results.filter(row => row?.result)
  if (!successful.length) throw new ChaoxingConfigError('已同步课程均未成功查询，请检查超星授权、课程权限后重试')
  const limitations = new Set<string>([`本次按已同步清单查询 ${courses.length} 个课程/班级，${successful.length} 个成功；课程清单来自本人网页导入，并非超星实时全量目录`])
  const resources: LearningResult['resources'] = []
  const seen = new Set<string>()
  for (const { course, result } of successful) {
    for (const note of result!.limitations) limitations.add(note)
    for (const resource of result!.resources) {
      const key = `${course.id}:${resource.kind}:${resource.id}`
      if (seen.has(key)) continue
      seen.add(key)
      resources.push({ ...resource, courseId: course.id, courseName: course.name })
    }
  }
  const failed = results.filter(row => row && !row.result)
  if (failed.length) limitations.add(`${failed.length} 个课程/班级查询失败（${failed.map(row => row.course.name).join('、').slice(0, 400)}），结果不完整；失败可能与权限或网络有关，不能视为无匹配资料`)
  if (next < courses.length || deadline.aborted) limitations.add('查询达到总时限，部分课程未完成，结果不完整')
  if (resources.length > 50) limitations.add('跨课程结果较多，仅展示前 50 条，结果不完整')
  return { resources: resources.slice(0, 50), limitations: [...limitations] }
}

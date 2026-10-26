export interface SyncedCourse { id: string; classId: string; name: string }

/** 浏览器导入只接受课程元数据，不转发导出文件里的其他字段。 */
export function parseCourseImport(input: string): SyncedCourse[] {
  if (input.length > 80_000) throw new Error('课程清单过大，最多同步 100 个课程/班级')
  const data: unknown = JSON.parse(input)
  const rows: unknown = Array.isArray(data) ? data : data && typeof data === 'object' && 'courses' in data ? data.courses : undefined
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new Error('请选择包含 1 至 100 个课程/班级的清单')
  const result: SyncedCourse[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('课程清单格式无效')
    const value = row as Record<string, unknown>
    const id = value.id ?? value.courseId
    if (typeof id !== 'string' || !/^[1-9][0-9]{0,29}$/.test(id) || typeof value.classId !== 'string' || !/^[1-9][0-9]{0,29}$/.test(value.classId) || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 200) throw new Error('清单缺少有效的课程名称、课程或班级信息')
    if (!result.some(course => course.id === id && course.classId === value.classId)) result.push({ id, classId: value.classId, name: value.name.trim() })
  }
  return result
}

/** 在用户自己的超星课程页运行；只读取可见课程链接，不读取密码、Cookie 或个人签名。 */
export function buildCourseSyncBookmarklet(origin: string): string {
  const destination = new URL('/settings', origin).href
  return `javascript:${encodeURIComponent(`(()=>{try{if(!/^mooc2-ans\\.chaoxing\\.com$/.test(location.hostname)||!location.pathname.endsWith('/visit/interaction'))throw Error('请先打开超星“我学的课”页面，再点击此同步书签');const courses=[];for(const a of document.querySelectorAll('h3 a[href]')){if(!a.getClientRects().length)continue;const u=new URL(a.getAttribute('href'),location.href),id=u.searchParams.get('courseid'),classId=u.searchParams.get('clazzid'),name=a.textContent.trim();if(!/^[1-9][0-9]{0,29}$/.test(id||'')||!/^[1-9][0-9]{0,29}$/.test(classId||'')||!name)continue;if(!courses.some(c=>c.id===id&&c.classId===classId))courses.push({id,classId,name});}if(!courses.length)throw Error('未读取到课程，请确认已登录并切换到“我学的课”');if(courses.length>100)throw Error('课程超过100个，请分批整理后通过清单文件导入');const w=window.open(${JSON.stringify(destination)}+'#chaoxing-courses='+encodeURIComponent(JSON.stringify({courses})),'_blank');if(!w)throw Error('请允许本次打开平台页面后重试');w.opener=null;}catch(e){alert(e.message||'同步失败，请重试');}})()`)} ` .trim()
}

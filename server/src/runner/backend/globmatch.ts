// runner backend glob 匹配（#747·02）：micromatch 包装（依赖与 deepagents deps 同版 ^4.0.8）。
// 两个调用点语义不同，分两个函数锁定：
//   matchGlobPattern —— glob() 的文件相对路径全语义（对齐官方 fg(pattern, {dot:true})）：
//                       模式相对搜索基目录（如 **/*.md、src/**、draft-?.md）。
//   matchGlobBaseName —— grep() includeGlob 的 basename 语义（对齐官方
//                       micromatch.isMatch(path.basename(fp), includeGlob)）：模式只匹配文件名段。

import micromatch from 'micromatch'

export function matchGlobPattern(relPath: string, pattern: string): boolean {
  return micromatch.isMatch(relPath, pattern, { dot: true })
}

export function matchGlobBaseName(absPath: string, pattern: string): boolean {
  const basename = absPath.slice(absPath.lastIndexOf('/') + 1)
  return micromatch.isMatch(basename, pattern, { dot: true })
}

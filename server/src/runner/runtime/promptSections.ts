// prompt 段拼接共享小工具（#747 R1 Standards⑦：自 graphFactory 私有函数提升为 runtime
// 共享——leader/subagent/wiki-update teammate 四调用点单一实现）。undefined/空串段剔除
// 不进拼接，段间 '\n\n' 分隔；filter(Boolean) 对全必填段调用点无行为影响。

export function joinSections(...sections: readonly (string | undefined)[]): string {
  return sections.filter(Boolean).join('\n\n')
}

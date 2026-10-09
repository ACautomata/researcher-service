// 事件桥（接缝 S3，issue #773；#747 C 节 / #726「薄投影」决策——上游事件不透传，
// 只在白名单内翻译为自有 SSE 目录）。
//
// 生产接线（#777 实测修正）：deepagents 1.14 / langgraph 1.4 的 agent.streamEvents 以
// **v3** protocol events 产出（{method,params} 形态），消费面 = runner/runtime/projector.ts
//（RunProjector）——本文件的 buildStreamEventsInvocation 是 v3 调用参数基座（PoC 坑 2
// 同参对象约束）。
// v2 经典 on_* 形态翻译面（#773 骨架期产物）已物理删除（#747 R1 Standards④：#777 实测
// v3 后生产零消费仅自测，原「删除归 T0 #801」注记指向的退役票已落地）；三包升级若上游
// 回退 v2 形态，按 projector.ts 白名单纪律重建翻译面。

// streamEvents 调用参数（PoC 坑 2 锁定，#747 A 节生产硬约束）：version + configurable
// 必须同一参数对象——resume 时参数不同会静默 no-op 假 done。构造一次、首次调用与 resume
// 复用；冻结防就地篡改。thread_id = LangGraph thread（sessionId，#727）。
// version 'v3'（#777 实测锁定，修正 #773 骨架期 v2 假设）：deepagents 1.14 / langgraph
// 1.4 的 agent.streamEvents 以 v3 产出 protocol events（{method,params} 形态）——v2 经典
// on_* 形态对 v3 投影（RunProjector）全部不可见。三包升级时以探针复测。
// checkpointId（#781 rewind）：非空 = time-travel 续跑（从该锚点 checkpoint 分叉——LangGraph
// 经 checkpointer.getTuple 精确寻址，saver 已支持）；缺省 = 链头（最新 checkpoint）。
export interface StreamEventsParams {
  readonly version: 'v3'
  readonly configurable: Readonly<{ thread_id: string; checkpoint_id?: string }>
}

export function buildStreamEventsInvocation(threadId: string, checkpointId?: string): StreamEventsParams {
  return Object.freeze({
    version: 'v3',
    configurable: Object.freeze({
      thread_id: threadId,
      ...(checkpointId !== undefined ? { checkpoint_id: checkpointId } : {}),
    }),
  })
}

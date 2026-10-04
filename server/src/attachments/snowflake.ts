// 雪花 ID（#747 G 节 D1）：时间有序、控制面单点生成无碰撞；与消息 32-hex 幂等 key 正交
//（附件 id 是沙箱目录名 + attachments 主键成分，幂等 key 是发送去重身份，两码不相干）。
// 63-bit：41-bit 毫秒时间戳（自定义 epoch）+ 10-bit worker + 12-bit 序号 → 十进制字符串。
// 单进程控制面内 worker 恒 1（多进程部署须按进程分 worker id——V1 单进程不涉及）。

const EPOCH_MS = 1735689600000n // 2025-01-01T00:00:00Z
const WORKER_ID = 1n
const SEQ_MASK = 0xfffn // 12-bit

let lastMs = 0n
let seq = 0n

// 生成一个雪花 id（时钟回拨：沿用上一毫秒时间戳——单点单调，不重复；序号溢出顺延下一毫秒）。
export function snowflakeId(now: number = Date.now()): string {
  let ts = BigInt(Math.max(0, now)) - EPOCH_MS
  if (ts < lastMs) ts = lastMs
  if (ts === lastMs) {
    seq = (seq + 1n) & SEQ_MASK
    if (seq === 0n) ts += 1n // 同毫秒 4096 个耗尽 → 顺延
  } else {
    seq = 0n
  }
  lastMs = ts
  return String((ts << 22n) | (WORKER_ID << 12n) | seq)
}

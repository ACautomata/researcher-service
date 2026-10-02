// 有界等待共享原语：Promise 预算内未 settle 即按超时路径放行。双队列同形消费
//（containers/bullmqQueue.ts 的 add 超时 + worker.close 有界关闭；runner/bullmqRunQueue.ts
// 同款——BullMQ producer connection 强制 maxRetriesPerRequest:null，坏 Redis 上 add 永挂；
// worker.close() drain 在坏 Redis 上可能挂起卡 shutdown）。
//
// 超时路径二语义：传 timeoutError → 以该错误 reject（调用方感知失败并补偿，如 runner
// submit 的 add.catch settle-drain）；不传 → resolve undefined 放行（void 语义面——
// shutdown 超时放行不该向调用方抛错）。timer unref 不阻进程退出，settle 即 clearTimeout。

export function raceWithTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  timeoutError?: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (timeoutError) reject(timeoutError())
      else resolve(undefined as T) // 调用面仅 void/放行语义（见头注）
    }, timeoutMs)
    timer.unref?.()
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

// minimax 默认 provider 一次性幂等 seed CLI（#775 · 731 §6 迁移）。
// 用法：npm run seed:minimax（tsx 直跑 TS——与 src/models/seedMinimax.ts 共享单一真值，
// 不经 prisma CLI，对齐 apply-schema.mjs 先例）。幂等可重跑：重跑零插入（验收）。
import { getPrisma } from '../src/prisma'
import { seedMinimaxDefaultProviders } from '../src/models/seedMinimax'

async function main(): Promise<void> {
  const prisma = getPrisma()
  try {
    const report = await seedMinimaxDefaultProviders(prisma)
    // eslint-disable-next-line no-console
    console.log(
      `[seed:minimax] seeded=${report.seededOwnerIds.length} skipped=${report.skippedOwners} folded=${report.foldedRows}`,
    )
    if (report.seededOwnerIds.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[seed:minimax] seeded owners: ${report.seededOwnerIds.join(', ')}`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[seed:minimax] failed:', e)
  process.exitCode = 1
})

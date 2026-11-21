// 真实进程重启验证缝：只通过公共业务口重试未知提交结果。
import { createPrismaClient } from '../../src/prisma'
import { createReflectionsRuntime } from '../../src/reflections/runtime'
const [url, context, request] = process.argv.slice(2)
const prisma = createPrismaClient(url!)
const runtime = createReflectionsRuntime(prisma)
try {
  console.log(JSON.stringify(await runtime.service.execute(JSON.parse(context!), JSON.parse(request!))))
} finally {
  await runtime.dispose()
  await prisma.$disconnect()
}

// reflections 运行时装配（#1080 · RF-T04）：内层 service + Prisma 适配的单一构造点。
//
// 生产组合根只在内部验证接缝注入（父规格：两个新工具统一等待完整门禁，不提前对用户开放）。

import type { PrismaClient } from '../generated/prisma/client'
import { PrismaReflectionStore } from './prismaAdapter'
import { ReflectionService } from './service'

export interface ReflectionsPort {
  execute: ReflectionService['execute']
  displayBodyText: ReflectionService['displayBodyText']
  draftBodyText: ReflectionService['draftBodyText']
  bindInFlightEvidence: PrismaReflectionStore['bindInFlightEvidence']
}

export interface ReflectionsRuntime {
  readonly store: PrismaReflectionStore
  readonly service: ReflectionService
  readonly port: ReflectionsPort
}

export function createReflectionsRuntime(prisma: PrismaClient): ReflectionsRuntime {
  const store = new PrismaReflectionStore(prisma)
  const service = new ReflectionService(store, store)
  const port: ReflectionsPort = {
    execute: (context, request, signal) => service.execute(context, request, signal),
    displayBodyText: (ownerId, displayId) => service.displayBodyText(ownerId, displayId),
    draftBodyText: (ownerId, draftId, version) => service.draftBodyText(ownerId, draftId, version),
    bindInFlightEvidence: (p) => store.bindInFlightEvidence(p),
  }
  return { store, service, port }
}

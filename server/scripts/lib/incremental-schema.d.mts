// 类型声明：scripts/lib/incremental-schema.mjs（纯 DDL 收敛脚本，无运行时行为——
// 测试与未来消费方 import 时补齐 TS 面；实现在 .mjs，铁律见该文件头注）。
export declare const SCHEMA_VERSION: number
export declare function runIncrementalSchema(db: unknown): void

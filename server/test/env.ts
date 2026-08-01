// vitest setupFile：在任何 src 导入前设置测试环境变量（静默 JWT_SECRET dev 告警）。
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-fixed'
process.env.NODE_ENV = 'test'

import { z } from 'zod'

export interface ChaoxingOptions {
  clientId: string
  clientSecret: string
  redirectUri: string
  credentialSecret: string
  transport?: 'openapi' | 'mcp'
  pkce?: boolean
  tokenAuth?: 'body' | 'basic'
}
export function readChaoxingOptions(): ChaoxingOptions | undefined {
  const values = [process.env.CHAOXING_CLIENT_ID, process.env.CHAOXING_CLIENT_SECRET, process.env.CHAOXING_REDIRECT_URI, process.env.CHAOXING_CREDENTIAL_SECRET]
  if (!values.some(Boolean)) return undefined
  const schema = z.object({
    clientId: z.string().min(1), clientSecret: z.string().min(1),
    redirectUri: z.string().url().refine(v => { const u = new URL(v); return !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) }),
    credentialSecret: z.string().min(32),
    transport: z.enum(['openapi', 'mcp']).default('openapi'),
    pkce: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
    tokenAuth: z.enum(['body', 'basic']).default('body'),
  })
  const parsed = schema.safeParse({ clientId: values[0], clientSecret: values[1], redirectUri: values[2], credentialSecret: values[3], transport: process.env.CHAOXING_TRANSPORT, pkce: process.env.CHAOXING_PKCE, tokenAuth: process.env.CHAOXING_TOKEN_AUTH })
  if (!parsed.success) throw new Error('超星配置无效：需完整配置 client id/secret、回调 URL、至少 32 字符加密根及有效授权选项')
  return parsed.data
}

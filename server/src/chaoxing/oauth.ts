import { tokenSchema } from './remote'
import type { ChaoxingOptions } from './options'

export function createChaoxingOAuth(options: ChaoxingOptions, network: typeof fetch) {
  return async (parameters: Record<string, string>) => {
    const body = new URLSearchParams({ ...parameters, client_id: options.clientId })
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
    if (options.tokenAuth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`).toString('base64')}`
    else body.set('client_secret', options.clientSecret)
    const response = await network('https://api.chaoxing.com/auth/oauth2/token', { method: 'POST', headers, body: body.toString(), redirect: 'error', signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error('超星令牌交换失败')
    return tokenSchema.parse(await response.json())
  }
}

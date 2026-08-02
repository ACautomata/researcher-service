import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// GATEWAY_TOKEN 落库加密（spec §5.2「真值不落盘」+ #310 EncryptedTextField 成对字段契约）。
// 旧 Django `Instance.token = EncryptedTextField(state_field='token_is_encrypted')` 应用层加密；
// M2 平移：DB 存密文 + `tokenEncrypted=true`，真值仅经 env 注入容器、仅解密后短暂存在内存。
//
// AES-256-GCM（认证加密）：key 由 JWT_SECRET 派生（同一主密钥，不再引入第二个 secret）；
// 格式 `base64(iv).base64(tag).base64(ct)`，GCM tag 自带完整性校验（篡改 → 解密抛错）。

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(`gateway-token:v1:${secret}`).digest()
}

export interface TokenCrypto {
  encrypt(plain: string): string
  decrypt(enc: string): string
}

export function createTokenCrypto(secret: string): TokenCrypto {
  const key = deriveKey(secret)
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`
    },
    decrypt(enc: string): string {
      const [ivB64, tagB64, ctB64] = enc.split('.')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
    },
  }
}

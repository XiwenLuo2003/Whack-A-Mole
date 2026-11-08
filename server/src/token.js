import crypto from 'crypto'
import { config } from './config.js'

export function signToken(roomId, playerId) {
  const body = Buffer.from(JSON.stringify({
    roomId,
    playerId,
    exp: Date.now() + config.tokenTtlMs,
  })).toString('base64url')
  const sig = crypto.createHmac('sha256', config.tokenSecret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null
  const splitAt = token.indexOf('.')
  if (splitAt <= 0) return null
  const body = token.slice(0, splitAt)
  const sig = token.slice(splitAt + 1)
  const expected = crypto.createHmac('sha256', config.tokenSecret).update(body).digest('base64url')
  const actualBuf = Buffer.from(sig)
  const expectedBuf = Buffer.from(expected)
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (!payload.roomId || !payload.playerId || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

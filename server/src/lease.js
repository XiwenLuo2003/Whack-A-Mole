import crypto from 'crypto'
import { redis } from './redis.js'
import { LEASE_MS } from './constants.js'

export const instanceId = crypto.randomUUID()

const LEASE_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 'ACQUIRED'
end
if current == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 'RENEWED'
end
return 'DENIED'
`

export async function acquireLease(roomId) {
  return redis.eval(LEASE_LUA, 1, `loop-owner:${roomId}`, instanceId, String(LEASE_MS))
}

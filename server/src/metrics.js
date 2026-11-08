import { redis } from './redis.js'
import { logger } from './logger.js'

const KEY = 'metrics:runtime'

async function add(field, amount = 1) {
  try {
    await redis.hincrby(KEY, field, amount)
  } catch (error) {
    logger.error(`metrics failed field=${field} message=${error.message}`)
  }
}

export function noteJoin(accepted) {
  return add(accepted ? 'joinAccepted' : 'joinRejected')
}

export function noteClaim({ accepted, replay, latencyMs }) {
  return Promise.all([
    add(replay ? 'claimReplay' : (accepted ? 'claimAccepted' : 'claimRejected')),
    add('claimLatencyMs', Math.max(0, latencyMs || 0)),
    add('claimSamples', 1),
  ]).catch((error) => logger.error(`metrics failed message=${error.message}`))
}

export function noteDisconnect() {
  return add('disconnects')
}

export function noteLua(latencyMs) {
  return Promise.all([
    add('luaMs', Math.max(0, Math.round(latencyMs || 0))),
    add('luaSamples', 1),
  ]).catch((error) => logger.error(`metrics failed message=${error.message}`))
}

export async function noteDrift(ms) {
  const drift = Math.max(0, Math.round(ms || 0))
  try {
    await redis.hset(KEY, 'loopDriftMs', String(drift))
    const max = Number(await redis.hget(KEY, 'loopDriftMaxMs') || 0)
    if (drift > max) await redis.hset(KEY, 'loopDriftMaxMs', String(drift))
  } catch (error) {
    logger.error(`metrics failed field=loopDriftMs message=${error.message}`)
  }
}

export async function readMetrics() {
  const [onlineRooms, raw] = await Promise.all([
    redis.scard('rooms:live'),
    redis.hgetall(KEY),
  ])
  const num = (field) => Number(raw[field] || 0)
  const accepted = num('claimAccepted')
  const rejected = num('claimRejected')
  const replay = num('claimReplay')
  const attempts = accepted + rejected
  const joins = num('joinAccepted')
  const luaSamples = num('luaSamples')
  const claimSamples = num('claimSamples')
  return {
    onlineRooms,
    joinRejected: num('joinRejected'),
    claimSuccessRate: attempts === 0 ? 0 : accepted / attempts,
    duplicateClickRate: claimSamples === 0 ? 0 : replay / claimSamples,
    disconnectRate: joins === 0 ? 0 : num('disconnects') / joins,
    loopDriftMs: num('loopDriftMs'),
    luaMs: luaSamples === 0 ? 0 : num('luaMs') / luaSamples,
  }
}

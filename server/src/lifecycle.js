import { redis } from './redis.js'
import { logger } from './logger.js'
import { emit } from './broadcast.js'
import { GRACE_MS, PRESENCE_TTL_SEC, CLOSED_TTL_SEC } from './constants.js'
import { readLeaderboard } from './roomStore.js'
import { archiveMatch } from './archive.js'

const REMOVE_LUA = `
local roomId = ARGV[1]
local playerId = ARGV[2]
local now = tonumber(ARGV[3])
local roomKey = 'room:' .. roomId
local playersKey = roomKey .. ':players'
local raw = redis.call('HGET', playersKey, playerId)
local playerCount = tonumber(redis.call('HGET', roomKey, 'playerCount') or '0')
if not raw then
  return cjson.encode({ removed = false, playerCount = playerCount })
end
local player = cjson.decode(raw)
local nicknameKey = player.nicknameKey or string.lower(player.nickname or '')
local status = redis.call('HGET', roomKey, 'status') or ''
local count = playerCount - 1
if count < 0 then count = 0 end
if count == 0 and (status == 'PREPARING' or status == 'COUNTDOWN') then
  local roomCode = redis.call('HGET', roomKey, 'roomCode') or ''
  local eventSeq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
  redis.call('DEL', playersKey, roomKey .. ':nicknames', roomKey .. ':scores', roomKey .. ':coin', roomKey .. ':ledger', roomKey .. ':departed')
  redis.call('DEL', 'presence:' .. roomId .. ':' .. playerId, 'prepare-lock:' .. roomId, roomKey)
  if roomCode ~= '' then redis.call('DEL', 'roomcode:' .. roomCode) end
  return cjson.encode({ removed = true, reset = true, playerCount = 0, status = 'WAITING', eventSeq = eventSeq, from = player.connectionState or 'ONLINE' })
end
redis.call('HDEL', playersKey, playerId)
if nicknameKey ~= '' then
  redis.call('HDEL', roomKey .. ':nicknames', nicknameKey)
end
local keptScore = tonumber(redis.call('ZSCORE', roomKey .. ':scores', playerId) or '0')
if status == 'PLAYING' or status == 'FINISHED' or status == 'CLOSED' then
  if status == 'PLAYING' then
    redis.call('RPUSH', roomKey .. ':departed', cjson.encode({
      playerId = playerId,
      nickname = player.nickname or '',
      score = keptScore,
      joinedAt = tonumber(player.joinedAt or '0')
    }))
  end
else
  redis.call('ZREM', roomKey .. ':scores', playerId)
end
redis.call('DEL', 'presence:' .. roomId .. ':' .. playerId)
redis.call('HSET', roomKey, 'playerCount', tostring(count))
local closed = false
local closedFrom = status
local finished = false
local removedCoinId = ''
local removedSeq = 0
local finishSeq = 0
local board = {}
if count == 0 and status == 'PLAYING' then
  local rows = redis.call('LRANGE', roomKey .. ':departed', 0, -1)
  for _, row in ipairs(rows) do
    board[#board + 1] = cjson.decode(row)
  end
  local coinKey = roomKey .. ':coin'
  local coinId = redis.call('HGET', coinKey, 'coinId')
  local coinStatus = redis.call('HGET', coinKey, 'status')
  if coinId and coinStatus == 'ACTIVE' then
    redis.call('HSET', coinKey, 'status', 'EXPIRED')
    removedCoinId = coinId
    removedSeq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
  end
  redis.call('HSET', roomKey, 'leaderboard', cjson.encode(board), 'status', 'FINISHED')
  finishSeq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
  finished = true
  redis.call('HSET', roomKey, 'status', 'CLOSED')
  status = 'CLOSED'
  closed = true
elseif count == 0 and status == 'FINISHED' then
  redis.call('HSET', roomKey, 'status', 'CLOSED')
  status = 'CLOSED'
  closed = true
end
local eventSeq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
return cjson.encode({
  removed = true,
  playerCount = count,
  from = player.connectionState or 'ONLINE',
  status = status,
  closed = closed,
  closedFrom = closedFrom,
  finished = finished,
  finishSeq = finishSeq,
  leaderboard = board,
  removedCoinId = removedCoinId,
  removedSeq = removedSeq,
  eventSeq = eventSeq,
  nickname = player.nickname or ''
})
`

const GRACE_LUA = `
local roomId = ARGV[1]
local playerId = ARGV[2]
local now = tonumber(ARGV[3])
local graceMs = tonumber(ARGV[4])
local roomKey = 'room:' .. roomId
local raw = redis.call('HGET', roomKey .. ':players', playerId)
if not raw then
  return cjson.encode({ ok = false, code = 'ABSENT' })
end
local player = cjson.decode(raw)
if player.connectionState == 'RECONNECTING' then
  return cjson.encode({ ok = true, changed = false, graceUntil = player.graceUntil or 0, from = 'RECONNECTING' })
end
local from = player.connectionState or 'ONLINE'
player.connectionState = 'RECONNECTING'
player.graceUntil = now + graceMs
redis.call('HSET', roomKey .. ':players', playerId, cjson.encode(player))
redis.call('DEL', 'presence:' .. roomId .. ':' .. playerId)
redis.call('ZADD', 'grace:index', player.graceUntil, roomId .. ':' .. playerId)
return cjson.encode({ ok = true, changed = true, from = from, graceUntil = player.graceUntil, lastSeenAt = player.lastSeenAt or 0 })
`

const RESUME_LUA = `
local roomId = ARGV[1]
local playerId = ARGV[2]
local now = tonumber(ARGV[3])
local presenceTtl = tonumber(ARGV[4])
local roomKey = 'room:' .. roomId
local raw = redis.call('HGET', roomKey .. ':players', playerId)
if not raw then
  return cjson.encode({ ok = false, code = 'PLAYER_NOT_ACTIVE' })
end
local player = cjson.decode(raw)
if player.connectionState == 'RECONNECTING' and tonumber(player.graceUntil or 0) > 0 and now > tonumber(player.graceUntil) then
  return cjson.encode({ ok = false, code = 'PLAYER_NOT_ACTIVE', expired = true })
end
local from = player.connectionState or 'ONLINE'
player.connectionState = 'ONLINE'
player.connectedOnce = 1
player.graceUntil = 0
player.lastSeenAt = now
redis.call('HSET', roomKey .. ':players', playerId, cjson.encode(player))
redis.call('SET', 'presence:' .. roomId .. ':' .. playerId, '1', 'EX', presenceTtl)
redis.call('ZREM', 'grace:index', roomId .. ':' .. playerId)
return cjson.encode({ ok = true, from = from, lastSeenAt = now })
`

function graceMember(roomId, playerId) {
  return `${roomId}:${playerId}`
}

export async function retainClosedRoom(roomId, reason = 'CLOSED') {
  const roomCode = await redis.hget(`room:${roomId}`, 'roomCode')
  const keys = [
    `room:${roomId}`,
    `room:${roomId}:players`,
    `room:${roomId}:nicknames`,
    `room:${roomId}:scores`,
    `room:${roomId}:coin`,
    `room:${roomId}:ledger`,
    `room:${roomId}:departed`,
    `prepare-lock:${roomId}`,
  ]
  if (roomCode) keys.push(`roomcode:${roomCode}`)
  for (const key of keys) {
    if (await redis.exists(key)) await redis.expire(key, CLOSED_TTL_SEC)
  }
  await redis.srem('rooms:live', roomId)
  await redis.del(`loop-owner:${roomId}`)
  logger.info(`[STATE] room roomId=${roomId} from=${reason} to=${reason} reason=RETAIN ttlSec=${CLOSED_TTL_SEC}`)
}

export async function removePlayer({ roomId, playerId, reason }) {
  const before = await redis.hget(`room:${roomId}:players`, playerId)
  const countNow = Number(await redis.hget(`room:${roomId}`, 'playerCount') || 0)
  const roomCode = await redis.hget(`room:${roomId}`, 'roomCode')
  const closingBoard = countNow <= 1 && before ? await readLeaderboard(roomId) : null
  logger.debug(`[STATE] player roomId=${roomId} playerId=${playerId} observe-before state=${before ? 'PRESENT' : 'ABSENT'} reason=${reason}`)
  const raw = await redis.eval(REMOVE_LUA, 0, roomId, playerId, String(Date.now()))
  const result = JSON.parse(raw)
  await redis.zrem('grace:index', graceMember(roomId, playerId))
  if (!result.removed) {
    logger.debug(`[STATE] player roomId=${roomId} playerId=${playerId} write=unchanged reason=${reason} alreadyLeft=1`)
    return result
  }
  logger.info(`[STATE] player roomId=${roomId} playerId=${playerId} from=${result.from} to=OFFLINE reason=${reason} playerCount=${result.playerCount}`)
  if (result.reset) {
    await redis.srem('rooms:live', roomId)
    await redis.del(`loop-owner:${roomId}`)
    logger.info(`[STATE] room roomId=${roomId} from=PREPARING to=WAITING reason=EMPTY playerCount=0`)
  }
  if (result.removedCoinId) {
    emit(roomId, 'coin.removed', result.removedSeq, { coinId: result.removedCoinId, reason: 'GAME_FINISHED' })
  }
  if (result.finished) {
    const board = (Array.isArray(result.leaderboard) ? result.leaderboard : [])
      .slice()
      .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
      .map((player, index) => ({ ...player, rank: index + 1 }))
    logger.info(`[STATE] room roomId=${roomId} from=PLAYING to=FINISHED reason=ALL_LEFT playerCount=0`)
    emit(roomId, 'game.finished', result.finishSeq, { finishedAt: Date.now(), leaderboard: board })
    archiveMatch({ roomId, roomCode, status: 'FINISHED', finishedAt: Date.now(), leaderboard: board })
  }
  if (result.closed) {
    logger.info(`[STATE] room roomId=${roomId} from=${result.finished ? 'FINISHED' : result.closedFrom} to=CLOSED reason=ALL_LEFT playerCount=0`)
    await retainClosedRoom(roomId)
    if (!result.finished) {
      archiveMatch({
        roomId,
        roomCode,
        status: 'CLOSED',
        finishedAt: Date.now(),
        leaderboard: closingBoard || [],
      })
    }
  }
  emit(roomId, 'player.left', result.eventSeq, {
    playerId,
    reason,
    playerCount: result.playerCount,
    status: result.status,
  })
  logger.info(`presence cleanup roomId=${roomId} playerId=${playerId} reason=${reason} playerCount=${result.playerCount}`)
  return result
}

export async function beginGrace({ roomId, playerId, reason }) {
  const now = Date.now()
  const raw = await redis.eval(GRACE_LUA, 0, roomId, playerId, String(now), String(GRACE_MS))
  const result = JSON.parse(raw)
  if (!result.ok || !result.changed) return result
  await redis.zadd('grace:index', result.graceUntil, graceMember(roomId, playerId))
  logger.info(`[STATE] player roomId=${roomId} playerId=${playerId} from=${result.from} to=RECONNECTING reason=${reason} lastSeenAt=${result.lastSeenAt} graceUntil=${result.graceUntil}`)
  return result
}

export async function resumeOnline({ roomId, playerId }) {
  const raw = await redis.eval(RESUME_LUA, 0, roomId, playerId, String(Date.now()), String(PRESENCE_TTL_SEC))
  const result = JSON.parse(raw)
  if (!result.ok) return result
  await redis.zrem('grace:index', graceMember(roomId, playerId))
  if (result.from !== 'ONLINE') {
    logger.info(`[STATE] player roomId=${roomId} playerId=${playerId} from=${result.from} to=ONLINE reason=RESUME lastSeenAt=${result.lastSeenAt}`)
  }
  return result
}

const TOUCH_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local player = cjson.decode(raw)
if player.connectionState ~= 'ONLINE' then return 0 end
player.lastSeenAt = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
return 1
`

export async function touchPresence({ roomId, playerId }) {
  await redis.set(`presence:${roomId}:${playerId}`, '1', 'EX', PRESENCE_TTL_SEC)
  await redis.eval(TOUCH_LUA, 1, `room:${roomId}:players`, playerId, String(Date.now()))
}

export async function sweepGrace() {
  const due = await redis.zrangebyscore('grace:index', 0, Date.now())
  for (const member of due) {
    const splitAt = member.indexOf(':')
    if (splitAt <= 0) continue
    const roomId = member.slice(0, splitAt)
    const playerId = member.slice(splitAt + 1)
    const raw = await redis.hget(`room:${roomId}:players`, playerId)
    if (!raw) {
      await redis.zrem('grace:index', member)
      continue
    }
    const player = JSON.parse(raw)
    if (player.connectionState !== 'RECONNECTING' || Number(player.graceUntil) > Date.now()) continue
    await removePlayer({ roomId, playerId, reason: 'GRACE_TIMEOUT' })
  }
}

export async function sweepZombies(io) {
  const roomIds = await redis.smembers('rooms:live')
  for (const roomId of roomIds) {
    const players = await redis.hgetall(`room:${roomId}:players`)
    const sockets = await io.in(roomId).fetchSockets()
    for (const [playerId, raw] of Object.entries(players)) {
      const player = JSON.parse(raw)
      if (player.connectionState !== 'ONLINE' || !player.connectedOnce) continue
      const alive = await redis.exists(`presence:${roomId}:${playerId}`)
      if (alive) continue
      if (sockets.some((socket) => socket.data.session?.playerId === playerId)) continue
      logger.warn(`presence expired roomId=${roomId} playerId=${playerId} reason=ZOMBIE`)
      await removePlayer({ roomId, playerId, reason: 'ZOMBIE' })
    }
  }
}

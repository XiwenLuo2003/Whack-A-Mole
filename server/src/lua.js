export const JOIN_LUA = `
local codeKey = KEYS[1]
local now = tonumber(ARGV[1])
local newRoomId = ARGV[2]
local roomCode = ARGV[3]
local playerId = ARGV[4]
local nickname = ARGV[5]
local nicknameKey = ARGV[6]
local prepareMs = tonumber(ARGV[7])
local countdownMs = tonumber(ARGV[8])
local maxPlayers = tonumber(ARGV[9])

local roomId = redis.call('GET', codeKey)
if not roomId then
  roomId = newRoomId
  local roomKey = 'room:' .. roomId
  redis.call('SET', codeKey, roomId)
  redis.call('HSET', roomKey,
    'roomId', roomId,
    'roomCode', roomCode,
    'status', 'WAITING',
    'playerCount', '0',
    'deadlineAt', '0',
    'gameStartedAt', '',
    'gameEndsAt', '',
    'nextCoinAt', '0',
    'eventSeq', '0',
    'createdAt', tostring(now))
  redis.call('SADD', 'rooms:live', roomId)
end

local roomKey = 'room:' .. roomId
local status = redis.call('HGET', roomKey, 'status')
if not status or status == 'CLOSED' then
  return cjson.encode({ ok = false, code = 'ROOM_CLOSED', from = status or 'NONE' })
end

local beforeCount = tonumber(redis.call('HGET', roomKey, 'playerCount') or '0')
if beforeCount >= maxPlayers then
  return cjson.encode({ ok = false, code = 'ROOM_FULL', playerCount = beforeCount, from = status })
end
if status == 'COUNTDOWN' or status == 'PLAYING' or status == 'FINISHED' then
  return cjson.encode({ ok = false, code = 'ROOM_STARTED', from = status, playerCount = beforeCount })
end
if status ~= 'WAITING' and status ~= 'PREPARING' then
  return cjson.encode({ ok = false, code = 'ROOM_STARTED', from = status, playerCount = beforeCount })
end

local nickKey = roomKey .. ':nicknames'
local existing = redis.call('HGET', nickKey, nicknameKey)
if existing then
  return cjson.encode({ ok = false, code = 'NICKNAME_TAKEN', from = status, playerCount = beforeCount })
end

local beforeDeadline = redis.call('HGET', roomKey, 'deadlineAt')
local playersKey = roomKey .. ':players'
local scoresKey = roomKey .. ':scores'
local playerJson = cjson.encode({
  playerId = playerId,
  roomId = roomId,
  nickname = nickname,
  nicknameKey = nicknameKey,
  score = 0,
  connectionState = 'ONLINE',
  joinedAt = now,
  lastSeenAt = now
})
redis.call('HSET', playersKey, playerId, playerJson)
redis.call('HSET', nickKey, nicknameKey, playerId)
redis.call('ZADD', scoresKey, 0, playerId)
local newCount = beforeCount + 1
redis.call('HSET', roomKey, 'playerCount', tostring(newCount))

local toStatus = status
local reason = 'PLAYER_JOINED'
local deadlineAt = tonumber(beforeDeadline) or 0
local phaseChanged = 0

if status == 'WAITING' and newCount == 1 then
  local deadline = tostring(now + prepareMs)
  local locked = redis.call('SET', 'prepare-lock:' .. roomId, deadline, 'NX')
  if locked then
    deadlineAt = tonumber(deadline)
  else
    deadlineAt = tonumber(redis.call('GET', 'prepare-lock:' .. roomId)) or (now + prepareMs)
  end
  redis.call('HSET', roomKey, 'status', 'PREPARING', 'deadlineAt', tostring(deadlineAt))
  toStatus = 'PREPARING'
  reason = 'FIRST_PLAYER'
  phaseChanged = 1
end

if newCount == maxPlayers and toStatus == 'PREPARING' then
  deadlineAt = now + countdownMs
  redis.call('HSET', roomKey, 'status', 'COUNTDOWN', 'deadlineAt', tostring(deadlineAt))
  toStatus = 'COUNTDOWN'
  reason = 'ROOM_FULL'
  phaseChanged = 1
end

local joinedSeq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
local countdownSeq = joinedSeq
if phaseChanged == 1 then
  countdownSeq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
end

return cjson.encode({
  ok = true,
  roomId = roomId,
  from = status,
  to = toStatus,
  reason = reason,
  playerCount = newCount,
  deadlineAt = deadlineAt,
  phaseChanged = phaseChanged,
  joinedSeq = joinedSeq,
  countdownSeq = countdownSeq,
  joinedAt = now
})
`

export const TICK_LUA = `
local roomId = ARGV[1]
local now = tonumber(ARGV[2])
local countdownMs = tonumber(ARGV[3])
local playingMs = tonumber(ARGV[4])
local coinId = ARGV[5]
local row = ARGV[6]
local col = ARGV[7]
local intervalMs = tonumber(ARGV[8])

local roomKey = 'room:' .. roomId
local status = redis.call('HGET', roomKey, 'status')
if not status then
  return cjson.encode({ ok = false, code = 'NO_ROOM' })
end
local playerCount = tonumber(redis.call('HGET', roomKey, 'playerCount') or '0')
local deadlineAt = tonumber(redis.call('HGET', roomKey, 'deadlineAt') or '0')
local gameEndsAt = tonumber(redis.call('HGET', roomKey, 'gameEndsAt') or '0')
local nextCoinAt = tonumber(redis.call('HGET', roomKey, 'nextCoinAt') or '0')
local coinKey = roomKey .. ':coin'

if status == 'PREPARING' then
  if deadlineAt > 0 and now >= deadlineAt then
    local current = redis.call('HGET', roomKey, 'status')
    if current ~= 'PREPARING' then
      return cjson.encode({ ok = false, code = 'CAS_FAILED', expected = 'PREPARING', actual = current or 'NONE', target = 'COUNTDOWN' })
    end
    local newDeadline = now + countdownMs
    redis.call('HSET', roomKey, 'status', 'COUNTDOWN', 'deadlineAt', tostring(newDeadline))
    local seq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
    return cjson.encode({
      ok = true, action = 'COUNTDOWN', from = 'PREPARING', to = 'COUNTDOWN', reason = 'PREPARE_TIMEOUT',
      deadlineAt = newDeadline, eventSeq = seq, status = 'COUNTDOWN', nextAt = newDeadline, playerCount = playerCount
    })
  end
  return cjson.encode({ ok = true, action = 'NONE', status = status, nextAt = deadlineAt, playerCount = playerCount })
end

if status == 'COUNTDOWN' then
  if deadlineAt > 0 and now >= deadlineAt then
    local current = redis.call('HGET', roomKey, 'status')
    if current ~= 'COUNTDOWN' then
      return cjson.encode({ ok = false, code = 'CAS_FAILED', expected = 'COUNTDOWN', actual = current or 'NONE', target = 'PLAYING' })
    end
    local ends = now + playingMs
    local nextAt = now + intervalMs
    redis.call('HSET', roomKey,
      'status', 'PLAYING',
      'gameStartedAt', tostring(now),
      'gameEndsAt', tostring(ends),
      'deadlineAt', tostring(ends),
      'nextCoinAt', tostring(nextAt))
    local seq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
    return cjson.encode({
      ok = true, action = 'START', from = 'COUNTDOWN', to = 'PLAYING', reason = 'COUNTDOWN_DONE',
      gameStartedAt = now, gameEndsAt = ends, deadlineAt = ends, eventSeq = seq,
      status = 'PLAYING', nextAt = nextAt, playerCount = playerCount
    })
  end
  return cjson.encode({ ok = true, action = 'NONE', status = status, nextAt = deadlineAt, playerCount = playerCount })
end

if status == 'PLAYING' then
  if gameEndsAt > 0 and now >= gameEndsAt then
    local current = redis.call('HGET', roomKey, 'status')
    if current ~= 'PLAYING' then
      return cjson.encode({ ok = false, code = 'CAS_FAILED', expected = 'PLAYING', actual = current or 'NONE', target = 'FINISHED' })
    end
    redis.call('HSET', roomKey, 'status', 'FINISHED', 'deadlineAt', tostring(gameEndsAt))
    local activeId = redis.call('HGET', coinKey, 'coinId')
    local coinStatus = redis.call('HGET', coinKey, 'status')
    local removedSeq = 0
    local removedId = ''
    if activeId and coinStatus == 'ACTIVE' then
      redis.call('HSET', coinKey, 'status', 'EXPIRED')
      removedSeq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
      removedId = activeId
    end
    local seq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
    return cjson.encode({
      ok = true, action = 'FINISH', from = 'PLAYING', to = 'FINISHED', reason = 'GAME_TIMEOUT',
      eventSeq = seq, removedCoinId = removedId, removedSeq = removedSeq, finishedAt = now,
      status = 'FINISHED', nextAt = 0, playerCount = playerCount, deadlineAt = gameEndsAt
    })
  end

  if nextCoinAt > 0 and now >= nextCoinAt then
    local activeId = redis.call('HGET', coinKey, 'coinId')
    local coinStatus = redis.call('HGET', coinKey, 'status')
    local removedSeq = 0
    local removedId = ''
    if activeId and coinStatus == 'ACTIVE' then
      redis.call('HSET', coinKey, 'status', 'EXPIRED')
      removedSeq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
      removedId = activeId
    end
    local expiresAt = now + intervalMs
    if expiresAt > gameEndsAt then expiresAt = gameEndsAt end
    if expiresAt <= now then
      return cjson.encode({ ok = true, action = 'NONE', status = status, nextAt = gameEndsAt, playerCount = playerCount, removedCoinId = removedId, removedSeq = removedSeq })
    end
    redis.call('DEL', coinKey)
    redis.call('HSET', coinKey,
      'coinId', coinId,
      'roomId', roomId,
      'row', tostring(row),
      'col', tostring(col),
      'status', 'ACTIVE',
      'spawnedAt', tostring(now),
      'expiresAt', tostring(expiresAt),
      'claimedBy', '',
      'claimedAt', '')
    redis.call('HSET', roomKey, 'nextCoinAt', tostring(expiresAt))
    local seq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
    return cjson.encode({
      ok = true, action = 'SPAWN', status = 'PLAYING', nextAt = expiresAt, playerCount = playerCount,
      coinId = coinId, row = tonumber(row), col = tonumber(col), spawnedAt = now, expiresAt = expiresAt,
      eventSeq = seq, removedCoinId = removedId, removedSeq = removedSeq
    })
  end

  local coinExpires = tonumber(redis.call('HGET', coinKey, 'expiresAt') or '0')
  local coinStatus = redis.call('HGET', coinKey, 'status')
  local nextAt = gameEndsAt
  if coinStatus == 'ACTIVE' and coinExpires > 0 then nextAt = coinExpires
  elseif nextCoinAt > 0 then nextAt = nextCoinAt end
  return cjson.encode({ ok = true, action = 'NONE', status = status, nextAt = nextAt, playerCount = playerCount })
end

return cjson.encode({ ok = true, action = 'NONE', status = status, nextAt = 0, playerCount = playerCount })
`

export const CLAIM_LUA = `
local roomId = ARGV[1]
local playerId = ARGV[2]
local coinId = ARGV[3]
local now = tonumber(ARGV[4])
local claimTtl = tonumber(ARGV[5])
local intervalMs = tonumber(ARGV[6])
local requestId = ARGV[7] or ''

local requestKey = 'request:' .. playerId .. ':' .. requestId
if requestId ~= '' then
  local cached = redis.call('GET', requestKey)
  if cached then
    return cjson.encode({ replay = true, payload = cached })
  end
end

local function finish(payload)
  local encoded = cjson.encode(payload)
  if requestId ~= '' then
    redis.call('SET', requestKey, encoded, 'EX', 120, 'NX')
  end
  return encoded
end

local roomKey = 'room:' .. roomId
local status = redis.call('HGET', roomKey, 'status')
if not status then
  return finish({ accepted = false, reason = 'GAME_NOT_PLAYING' })
end
local gameEndsAt = tonumber(redis.call('HGET', roomKey, 'gameEndsAt') or '0')
if status == 'FINISHED' or status == 'CLOSED' then
  return finish({ accepted = false, reason = 'GAME_ENDED' })
end
if status ~= 'PLAYING' then
  return finish({ accepted = false, reason = 'GAME_NOT_PLAYING' })
end
if gameEndsAt > 0 and now >= gameEndsAt then
  return finish({ accepted = false, reason = 'GAME_ENDED' })
end

local rawPlayer = redis.call('HGET', roomKey .. ':players', playerId)
if not rawPlayer then
  return finish({ accepted = false, reason = 'PLAYER_NOT_ACTIVE' })
end
local player = cjson.decode(rawPlayer)
if player.connectionState ~= 'ONLINE' then
  return finish({ accepted = false, reason = 'PLAYER_NOT_ACTIVE' })
end

local coinKey = roomKey .. ':coin'
local activeId = redis.call('HGET', coinKey, 'coinId')
local coinStatus = redis.call('HGET', coinKey, 'status')
local claimKey = 'claim:' .. roomId .. ':' .. coinId
if activeId ~= coinId or coinStatus ~= 'ACTIVE' then
  local winner = redis.call('GET', claimKey)
  if winner then
    return finish({ accepted = false, reason = 'ALREADY_CLAIMED', winnerId = winner })
  end
  return finish({ accepted = false, reason = 'INVALID_COIN' })
end
local expiresAt = tonumber(redis.call('HGET', coinKey, 'expiresAt') or '0')
if expiresAt > 0 and now >= expiresAt then
  return finish({ accepted = false, reason = 'INVALID_COIN' })
end

local setOk = redis.call('SET', claimKey, playerId, 'NX', 'EX', claimTtl)
if not setOk then
  local winner = redis.call('GET', claimKey)
  return finish({ accepted = false, reason = 'ALREADY_CLAIMED', winnerId = winner or '' })
end

local scoresKey = roomKey .. ':scores'
local before = tonumber(redis.call('ZSCORE', scoresKey, playerId) or '0')
local score = tonumber(redis.call('ZINCRBY', scoresKey, 1, playerId))
player.score = score
redis.call('HSET', roomKey .. ':players', playerId, cjson.encode(player))
redis.call('HSET', coinKey, 'status', 'CLAIMED', 'claimedBy', playerId, 'claimedAt', tostring(now))
redis.call('RPUSH', roomKey .. ':ledger', cjson.encode({ coinId = coinId, playerId = playerId, score = score, claimedAt = now }))
local nextAt = now + intervalMs
redis.call('HSET', roomKey, 'nextCoinAt', tostring(nextAt))
local rankIndex = redis.call('ZREVRANK', scoresKey, playerId)
local rank = 1
if rankIndex then rank = tonumber(rankIndex) + 1 end
local claimedSeq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
local scoreSeq = redis.call('HINCRBY', roomKey, 'eventSeq', 1)
return finish({
  accepted = true,
  winnerId = playerId,
  score = score,
  scoreBefore = before,
  rank = rank,
  claimedAt = now,
  nextAt = nextAt,
  claimedSeq = claimedSeq,
  scoreSeq = scoreSeq
})
`

import crypto from 'crypto'
import { redis } from './redis.js'
import { logger } from './logger.js'
import { emit } from './broadcast.js'
import { signToken } from './token.js'
import { JOIN_LUA, CLAIM_LUA } from './lua.js'
import {
  CLAIM_RATE_LIMIT,
  CLAIM_TTL_SEC,
  COIN_INTERVAL_MAX_MS,
  COIN_INTERVAL_MIN_MS,
  COUNTDOWN_MS,
  MAX_PLAYERS,
  PREPARE_MS,
  PRESENCE_TTL_SEC,
  randomInt,
} from './constants.js'
import { JOIN_ERROR_TEXT } from './httpUtil.js'
import { noteClaim, noteJoin, noteLua } from './metrics.js'

const ROOM_CODE = /^[A-Z0-9]{6}$/

export function validateJoinInput(roomCode, nickname) {
  if (typeof roomCode !== 'string' || !ROOM_CODE.test(roomCode)) {
    return { code: 'INVALID_ROOM_CODE', message: JOIN_ERROR_TEXT.INVALID_ROOM_CODE }
  }
  const trimmed = typeof nickname === 'string' ? nickname.trim() : ''
  if (!trimmed || [...trimmed].length > 20) {
    return { code: 'INVALID_NICKNAME', message: JOIN_ERROR_TEXT.INVALID_NICKNAME }
  }
  return null
}

function emptyToNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

export async function readSnapshot(roomId) {
  const room = await redis.hgetall(`room:${roomId}`)
  if (!room?.roomId) return null
  const playersRaw = await redis.hgetall(`room:${roomId}:players`)
  const scorePairs = await redis.zrange(`room:${roomId}:scores`, 0, -1, 'WITHSCORES')
  const scores = {}
  for (let i = 0; i < scorePairs.length; i += 2) {
    scores[scorePairs[i]] = Number(scorePairs[i + 1])
  }
  const players = Object.values(playersRaw).map((raw) => {
    const player = JSON.parse(raw)
    return {
      playerId: player.playerId,
      nickname: player.nickname,
      score: scores[player.playerId] ?? (Number(player.score) || 0),
      connectionState: player.connectionState,
      joinedAt: Number(player.joinedAt),
    }
  }).sort((a, b) => a.joinedAt - b.joinedAt)
  const coin = await redis.hgetall(`room:${roomId}:coin`)
  const activeCoin = coin?.coinId && coin.status === 'ACTIVE'
    ? {
      coinId: coin.coinId,
      row: Number(coin.row),
      col: Number(coin.col),
      status: coin.status,
      spawnedAt: Number(coin.spawnedAt),
      expiresAt: Number(coin.expiresAt),
    }
    : null
  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    status: room.status,
    playerCount: Number(room.playerCount) || 0,
    deadlineAt: Number(room.deadlineAt) || 0,
    gameStartedAt: emptyToNull(room.gameStartedAt),
    gameEndsAt: emptyToNull(room.gameEndsAt),
    eventSeq: Number(room.eventSeq) || 0,
    createdAt: Number(room.createdAt) || 0,
    players,
    scores,
    activeCoin,
  }
}

function ackFromClaim(requestId, result) {
  return {
    requestId,
    accepted: Boolean(result.accepted),
    reason: result.accepted ? null : (result.reason || null),
    winnerId: result.winnerId || null,
    serverTime: Date.now(),
  }
}

export async function readLeaderboard(roomId) {
  const frozen = await redis.hget(`room:${roomId}`, 'leaderboard')
  if (frozen) {
    const rows = JSON.parse(frozen)
    if (Array.isArray(rows)) {
      return rows
        .slice()
        .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
        .map((player, index) => ({
          playerId: player.playerId,
          nickname: player.nickname,
          score: Number(player.score) || 0,
          rank: index + 1,
        }))
    }
  }
  const snapshot = await readSnapshot(roomId)
  if (!snapshot) return []
  const departedRaw = await redis.lrange(`room:${roomId}:departed`, 0, -1)
  const seen = new Set(snapshot.players.map((player) => player.playerId))
  const extras = []
  for (const raw of departedRaw) {
    const row = JSON.parse(raw)
    if (row?.playerId && !seen.has(row.playerId)) {
      extras.push({
        playerId: row.playerId,
        nickname: row.nickname,
        score: Number(row.score) || 0,
        joinedAt: Number(row.joinedAt) || 0,
      })
    }
  }
  return [...snapshot.players, ...extras]
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
    .map((player, index) => ({
      playerId: player.playerId,
      nickname: player.nickname,
      score: player.score,
      rank: index + 1,
    }))
}

export async function joinRoom({ roomCode, nickname, requestId }) {
  const invalid = validateJoinInput(roomCode, nickname)
  if (invalid) {
    noteJoin(false)
    return { http: 400, error: invalid }
  }

  const trimmed = nickname.trim()
  const existingId = await redis.get(`roomcode:${roomCode}`)
  const before = existingId ? await redis.hgetall(`room:${existingId}`) : null
  logger.debug(`[STATE] room roomCode=${roomCode} observe-before status=${before?.status ?? 'NONE'} playerCount=${before?.playerCount ?? 0} deadlineAt=${before?.deadlineAt ?? 0} activeCoin=- reason=JOIN_ATTEMPT requestId=${requestId}`)

  const now = Date.now()
  const playerId = crypto.randomUUID()
  const raw = await redis.eval(
    JOIN_LUA,
    1,
    `roomcode:${roomCode}`,
    String(now),
    crypto.randomUUID(),
    roomCode,
    playerId,
    trimmed,
    trimmed.toLowerCase(),
    String(PREPARE_MS),
    String(COUNTDOWN_MS),
    String(MAX_PLAYERS),
  )
  const result = JSON.parse(raw)
  if (!result.ok) {
    if (result.code === 'CAS_FAILED') {
      logger.warn(`[STATE] room roomCode=${roomCode} cas-failed expected=${result.expected} actual=${result.actual} target=${result.target} requestId=${requestId}`)
    }
    logger.debug(`[STATE] room roomCode=${roomCode} write=failed code=${result.code} playerCount=${result.playerCount ?? before?.playerCount ?? 0} requestId=${requestId}`)
    noteJoin(false)
    return {
      http: 409,
      error: { code: result.code, message: JOIN_ERROR_TEXT[result.code] || result.code },
    }
  }

  logger.debug(`[STATE] player roomId=${result.roomId} playerId=${playerId} from=ABSENT to=ONLINE reason=JOIN`)
  logger.info(`[STATE] room roomId=${result.roomId} from=${result.from} to=${result.to} reason=${result.reason} playerCount=${result.playerCount} deadlineAt=${result.deadlineAt}`)
  logger.info(`player joined roomId=${result.roomId} playerId=${playerId} nickname=${trimmed} playerCount=${result.playerCount}`)
  noteJoin(true)
  emit(result.roomId, 'player.joined', result.joinedSeq, {
    player: {
      playerId,
      nickname: trimmed,
      score: 0,
      connectionState: 'ONLINE',
      joinedAt: result.joinedAt,
    },
    playerCount: result.playerCount,
  })
  if (result.phaseChanged) {
    emit(result.roomId, 'game.countdown', result.countdownSeq, {
      phase: result.to,
      deadlineAt: result.deadlineAt,
    })
  }
  await redis.set(`presence:${result.roomId}:${playerId}`, '1', 'EX', PRESENCE_TTL_SEC)

  const snapshot = await readSnapshot(result.roomId)

  return {
    http: 200,
    data: {
      roomId: result.roomId,
      playerId,
      playerToken: signToken(result.roomId, playerId),
      wsUrl: '/ws',
      snapshot,
    },
  }
}

export async function claimCoin({ roomId, playerId, coinId, requestId, clickedAt }) {
  const serverReceiveAt = Date.now()
  const observed = (result) => {
    const latencyMs = Date.now() - serverReceiveAt
    logger.info(`claim observed roomId=${roomId} coinId=${coinId || '-'} playerId=${playerId} requestId=${requestId || '-'} serverReceiveAt=${serverReceiveAt} result=${result} latencyMs=${latencyMs}`)
    noteClaim({ accepted: result === 'ACCEPTED', replay: result === 'REPLAY', latencyMs })
  }
  logger.debug(`[IN ] ws   coin.claim requestId=${requestId} roomId=${roomId} playerId=${playerId} coinId=${coinId} clickedAt=${clickedAt ?? '-'}`)
  if (typeof coinId !== 'string' || typeof requestId !== 'string' || !coinId || !requestId || coinId.length > 80) {
    logger.warn(`claim lock coinId=${coinId || '-'} playerId=${playerId} acquired=false winnerId=- reason=INVALID_COIN`)
    observed('INVALID_COIN')
    return {
      ack: {
        requestId: requestId || null,
        accepted: false,
        reason: 'INVALID_COIN',
        winnerId: null,
        serverTime: Date.now(),
      },
      events: [],
    }
  }

  const cached = await redis.get(`request:${playerId}:${requestId}`)
  if (cached) {
    const payload = JSON.parse(cached)
    logger.warn(`claim replay requestId=${requestId} roomId=${roomId} playerId=${playerId} coinId=${coinId} accepted=${Boolean(payload.accepted)} reason=${payload.reason || 'OK'}`)
    observed('REPLAY')
    return { ack: ackFromClaim(requestId, payload), events: [] }
  }
  const rateKey = `rate:${playerId}:${Math.floor(Date.now() / 1000)}`
  const attempts = await redis.incr(rateKey)
  if (attempts === 1) await redis.expire(rateKey, 2)
  if (attempts > CLAIM_RATE_LIMIT) {
    logger.warn(`claim rate-limited playerId=${playerId} requestId=${requestId} attempts=${attempts}`)
    const limited = { accepted: false, reason: 'RATE_LIMITED', winnerId: '' }
    await redis.set(`request:${playerId}:${requestId}`, JSON.stringify(limited), 'EX', 120, 'NX')
    const stored = await redis.get(`request:${playerId}:${requestId}`)
    const payload = stored ? JSON.parse(stored) : limited
    observed(payload.accepted ? 'ACCEPTED' : (payload.reason || 'RATE_LIMITED'))
    return {
      ack: ackFromClaim(requestId, payload),
      events: [],
    }
  }

  const before = await redis.hgetall(`room:${roomId}:coin`)
  logger.debug(`[STATE] coin roomId=${roomId} coinId=${coinId} observe-before status=${before?.status ?? 'NONE'} activeCoin=${before?.coinId ?? '-'} reason=CLAIM_ATTEMPT`)
  const now = Date.now()
  const luaStarted = Date.now()
  const raw = await redis.eval(
    CLAIM_LUA,
    0,
    roomId,
    playerId,
    coinId,
    String(now),
    String(CLAIM_TTL_SEC),
    String(randomInt(COIN_INTERVAL_MIN_MS, COIN_INTERVAL_MAX_MS)),
    requestId,
  )
  noteLua(Date.now() - luaStarted)
  const result = JSON.parse(raw)
  if (result.replay) {
    const payload = JSON.parse(result.payload)
    logger.warn(`claim replay requestId=${requestId} roomId=${roomId} playerId=${playerId} coinId=${coinId} accepted=${Boolean(payload.accepted)} reason=${payload.reason || 'OK'}`)
    observed('REPLAY')
    return { ack: ackFromClaim(requestId, payload), events: [] }
  }
  if (!result.accepted) {
    logger.warn(`claim lock coinId=${coinId} playerId=${playerId} acquired=false winnerId=${result.winnerId || '-'} reason=${result.reason}`)
    logger.debug(`[STATE] coin roomId=${roomId} coinId=${coinId} write=failed reason=${result.reason}`)
    observed(result.reason || 'REJECTED')
    return {
      ack: {
        requestId,
        accepted: false,
        reason: result.reason,
        winnerId: result.winnerId || null,
        serverTime: Date.now(),
      },
      events: [],
    }
  }

  logger.info(`claim lock coinId=${coinId} playerId=${playerId} acquired=true winnerId=${playerId}`)
  logger.debug(`[STATE] coin roomId=${roomId} coinId=${coinId} from=ACTIVE to=CLAIMED reason=CLAIM_SUCCESS winnerId=${playerId} score=${result.score}`)
  logger.debug(`[STATE] player roomId=${roomId} playerId=${playerId} from=score:${result.scoreBefore} to=score:${result.score} reason=CLAIM_SUCCESS`)
  observed('ACCEPTED')
  const board = await readLeaderboard(roomId)
  const rank = board.find((row) => row.playerId === playerId)?.rank || result.rank
  return {
    ack: {
      requestId,
      accepted: true,
      reason: null,
      winnerId: playerId,
      serverTime: Date.now(),
    },
    events: [
      {
        name: 'coin.claimed',
        seq: result.claimedSeq,
        fields: {
          coinId,
          winnerId: playerId,
          score: result.score,
          claimedAt: result.claimedAt,
        },
      },
      {
        name: 'score.updated',
        seq: result.scoreSeq,
        fields: {
          playerId,
          score: result.score,
          rank,
        },
      },
    ],
  }
}

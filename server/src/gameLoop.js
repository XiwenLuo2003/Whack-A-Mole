import crypto from 'crypto'
import { redis } from './redis.js'
import { logger } from './logger.js'
import { emit } from './broadcast.js'
import { TICK_LUA } from './lua.js'
import { readLeaderboard } from './roomStore.js'
import { acquireLease } from './lease.js'
import { archiveMatch } from './archive.js'
import { noteDrift, noteLua } from './metrics.js'
import { retainClosedRoom } from './lifecycle.js'
import {
  COIN_INTERVAL_MAX_MS,
  COIN_INTERVAL_MIN_MS,
  COUNTDOWN_MS,
  PLAYING_MS,
  TICK_MS,
  randomInt,
} from './constants.js'

const ACTION_LABEL = {
  NONE: '无',
  COUNTDOWN: '切阶段',
  START: '切阶段',
  FINISH: '结束',
  SPAWN: '生成金币',
}

function likelyDue(room, now) {
  if (!room?.status) return false
  const deadlineAt = Number(room.deadlineAt || 0)
  const nextCoinAt = Number(room.nextCoinAt || 0)
  const gameEndsAt = Number(room.gameEndsAt || 0)
  if ((room.status === 'PREPARING' || room.status === 'COUNTDOWN') && deadlineAt > 0 && now >= deadlineAt) return true
  if (room.status === 'PLAYING' && gameEndsAt > 0 && now >= gameEndsAt) return true
  if (room.status === 'PLAYING' && nextCoinAt > 0 && now >= nextCoinAt) return true
  return false
}

async function tickRoom(roomId) {
  const observed = await redis.hgetall(`room:${roomId}`)
  if (!observed?.status) {
    await redis.srem('rooms:live', roomId)
    return
  }
  const lease = await acquireLease(roomId)
  if (lease === 'DENIED') {
    logger.debug(`[LOOP] roomId=${roomId} status=${observed.status} action=跳过 reason=LEASE_HELD`)
    return
  }
  const now = Date.now()
  const due = likelyDue(observed, now)
  if (due) {
    const activeCoin = observed.status === 'PLAYING' ? (await redis.hget(`room:${roomId}:coin`, 'coinId')) || '-' : '-'
    logger.debug(`[STATE] room roomId=${roomId} observe-before status=${observed.status} playerCount=${observed.playerCount} deadlineAt=${observed.deadlineAt} activeCoin=${activeCoin} reason=TICK_DUE`)
  }
  const intervalMs = randomInt(COIN_INTERVAL_MIN_MS, COIN_INTERVAL_MAX_MS)
  const luaStarted = Date.now()
  const raw = await redis.eval(
    TICK_LUA,
    0,
    roomId,
    String(now),
    String(COUNTDOWN_MS),
    String(PLAYING_MS),
    crypto.randomUUID(),
    String(randomInt(0, 4)),
    String(randomInt(0, 4)),
    String(intervalMs),
  )
  noteLua(Date.now() - luaStarted)
  const plannedAt = Number(observed.nextCoinAt || observed.deadlineAt || 0)
  if (plannedAt > 0 && now > plannedAt) noteDrift(now - plannedAt)
  const result = JSON.parse(raw)
  if (!result.ok) {
    logger.warn(`[STATE] room roomId=${roomId} cas-failed expected=${result.expected ?? '-'} actual=${result.actual ?? '-'} target=${result.target ?? '-'} code=${result.code}`)
    return
  }
  logger.debug(`[LOOP] roomId=${roomId} status=${result.status} nextAt=${result.nextAt || 0} action=${ACTION_LABEL[result.action] || result.action}`)
  if (result.removedCoinId) {
    const removedReason = result.action === 'FINISH' ? 'GAME_FINISHED' : (result.action === 'SPAWN' ? 'REPLACED' : 'EXPIRED')
    emit(roomId, 'coin.removed', result.removedSeq, {
      coinId: result.removedCoinId,
      reason: removedReason,
    })
    logger.debug(`[STATE] coin roomId=${roomId} coinId=${result.removedCoinId} from=ACTIVE to=EXPIRED reason=${removedReason}`)
  }
  if (result.action === 'COUNTDOWN') {
    logger.info(`[STATE] room roomId=${roomId} from=${result.from} to=${result.to} reason=${result.reason} playerCount=${result.playerCount} deadlineAt=${result.deadlineAt}`)
    emit(roomId, 'game.countdown', result.eventSeq, { phase: 'COUNTDOWN', deadlineAt: result.deadlineAt })
  } else if (result.action === 'START') {
    logger.info(`[STATE] room roomId=${roomId} from=${result.from} to=${result.to} reason=${result.reason} playerCount=${result.playerCount} deadlineAt=${result.deadlineAt}`)
    emit(roomId, 'game.started', result.eventSeq, {
      startedAt: result.gameStartedAt,
      gameEndsAt: result.gameEndsAt,
    })
  } else if (result.action === 'SPAWN') {
    logger.debug(`[STATE] coin roomId=${roomId} coinId=${result.coinId} from=NONE to=ACTIVE reason=SPAWN row=${result.row} col=${result.col}`)
    emit(roomId, 'coin.spawned', result.eventSeq, {
      coinId: result.coinId,
      row: result.row,
      col: result.col,
      spawnedAt: result.spawnedAt,
      expiresAt: result.expiresAt,
    })
  } else if (result.action === 'FINISH') {
    logger.info(`[STATE] room roomId=${roomId} from=${result.from} to=${result.to} reason=${result.reason} playerCount=${result.playerCount} deadlineAt=${result.deadlineAt}`)
    const leaderboard = await readLeaderboard(roomId)
    emit(roomId, 'game.finished', result.eventSeq, {
      finishedAt: result.finishedAt,
      leaderboard,
    })
    archiveMatch({
      roomId,
      roomCode: observed.roomCode,
      status: 'FINISHED',
      finishedAt: result.finishedAt,
      leaderboard,
    })
    await redis.hset(`room:${roomId}`, 'leaderboard', JSON.stringify(leaderboard))
    await retainClosedRoom(roomId, 'FINISHED')
    await redis.srem('rooms:live', roomId)
  } else if (result.status === 'FINISHED' || result.status === 'CLOSED') {
    await redis.srem('rooms:live', roomId)
  } else if (due && result.action === 'NONE') {
    logger.debug(`[STATE] room roomId=${roomId} write=unchanged status=${result.status} reason=TICK_NO_CHANGE`)
  }
}

export function startGameLoop() {
  let running = false
  setInterval(async () => {
    if (running) return
    running = true
    try {
      const roomIds = await redis.smembers('rooms:live')
      for (const roomId of roomIds) {
        try {
          await tickRoom(roomId)
        } catch (error) {
          logger.error(`game loop room failed roomId=${roomId} message=${error.message}`)
        }
      }
    } catch (error) {
      logger.error(`game loop failed message=${error.message}`)
    } finally {
      running = false
    }
  }, TICK_MS)
  redis.smembers('rooms:live').then((roomIds) => {
    logger.info(`game loop recover rooms=${roomIds.length} basis=redis-deadline instance=${process.pid}`)
  }).catch((error) => logger.error(`game loop recover failed message=${error.message}`))
  logger.info(`game loop started tickMs=${TICK_MS}`)
}

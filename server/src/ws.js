import { logger, maskSecret } from './logger.js'
import { verifyToken } from './token.js'
import { claimCoin, readSnapshot } from './roomStore.js'
import { emit } from './broadcast.js'
import { beginGrace, resumeOnline, sweepGrace, sweepZombies, touchPresence } from './lifecycle.js'
import { HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS } from './constants.js'
import { noteDisconnect } from './metrics.js'
import { redis } from './redis.js'

function sessionError(socket, code, message, token) {
  logger.warn(`[OUT] ws   room.error code=${code} tokenTail=${maskSecret(token)}`)
  socket.emit('room.error', { code, message, serverTime: Date.now() })
  socket.disconnect(true)
}

export function attachSocket(io) {
  io.on('connection', (socket) => {
    socket.data.lastPongAt = Date.now()

    socket.on('room.resume', async (payload = {}) => {
      const token = payload.playerToken
      logger.debug(`[IN ] ws   room.resume requestId=${payload.requestId || '-'} roomId=- playerId=- tokenTail=${maskSecret(token)}`)
      const session = verifyToken(token)
      if (!session) {
        sessionError(socket, 'UNAUTHORIZED', '令牌无效', token)
        return
      }
      const resumed = await resumeOnline({ roomId: session.roomId, playerId: session.playerId })
      if (!resumed.ok) {
        sessionError(socket, 'PLAYER_NOT_ACTIVE', '席位已失效', token)
        return
      }
      socket.data.session = session
      socket.data.lastPongAt = Date.now()
      await socket.join(session.roomId)
      const snapshot = await readSnapshot(session.roomId)
      if (!snapshot) {
        socket.emit('room.error', {
          code: 'ROOM_CLOSED',
          message: '房间不存在',
          roomId: session.roomId,
          serverTime: Date.now(),
        })
        return
      }
      const message = { ...snapshot, serverTime: Date.now() }
      logger.debug(`[OUT] ws   room.snapshot eventSeq=${snapshot.eventSeq} roomId=${session.roomId} status=${snapshot.status}`)
      socket.emit('room.snapshot', message)
    })

    socket.on('room.sync', async (payload = {}) => {
      const session = socket.data.session
      if (!session) {
        socket.emit('room.error', { code: 'UNAUTHORIZED', message: '未加入房间', serverTime: Date.now() })
        return
      }
      logger.debug(`[IN ] ws   room.sync roomId=${session.roomId} playerId=${session.playerId} lastEventSeq=${payload.lastEventSeq ?? '-'}`)
      const snapshot = await readSnapshot(session.roomId)
      if (!snapshot) {
        socket.emit('room.error', { code: 'ROOM_CLOSED', message: '房间不存在', roomId: session.roomId, serverTime: Date.now() })
        return
      }
      const message = { ...snapshot, serverTime: Date.now() }
      logger.debug(`[OUT] ws   room.snapshot eventSeq=${snapshot.eventSeq} roomId=${session.roomId} status=${snapshot.status} reason=SYNC`)
      socket.emit('room.snapshot', message)
    })

    socket.on('pong', async (payload = {}) => {
      const session = socket.data.session
      if (!session) return
      socket.data.lastPongAt = Date.now()
      await touchPresence({ roomId: session.roomId, playerId: session.playerId })
      logger.debug(`[IN ] ws   pong roomId=${session.roomId} playerId=${session.playerId} nonce=${payload.nonce || '-'}`)
    })

    socket.on('coin.claim', async (payload = {}, callback) => {
      const reply = (body) => {
        logger.debug(`[OUT] ws   coin.claim requestId=${body.requestId || '-'} accepted=${body.accepted} code=${body.reason || 'OK'}`)
        if (typeof callback === 'function') callback(body)
      }
      const session = socket.data.session
      if (!session) {
        reply({
          requestId: payload.requestId || null,
          accepted: false,
          reason: 'PLAYER_NOT_ACTIVE',
          winnerId: null,
          serverTime: Date.now(),
        })
        return
      }
      const bodySize = Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf8')
      if (bodySize > 4096) {
        reply({
          requestId: payload.requestId || null,
          accepted: false,
          reason: 'PAYLOAD_TOO_LARGE',
          winnerId: null,
          serverTime: Date.now(),
        })
        return
      }
      try {
        const outcome = await claimCoin({
          roomId: session.roomId,
          playerId: session.playerId,
          coinId: payload.coinId,
          requestId: payload.requestId,
          clickedAt: payload.clickedAt,
        })
        reply(outcome.ack)
        for (const event of outcome.events) {
          emit(session.roomId, event.name, event.seq, event.fields)
        }
      } catch (error) {
        logger.error(`coin.claim failed roomId=${session.roomId} playerId=${session.playerId} message=${error.message}`)
        reply({
          requestId: payload.requestId || null,
          accepted: false,
          reason: 'INVALID_COIN',
          winnerId: null,
          serverTime: Date.now(),
        })
      }
    })

    socket.on('disconnect', async () => {
      const session = socket.data.session
      if (!session) return
      const sockets = await io.in(session.roomId).fetchSockets()
      const stillHere = sockets.some((item) => item.id !== socket.id && item.data.session?.playerId === session.playerId)
      if (stillHere) return
      await beginGrace({ roomId: session.roomId, playerId: session.playerId, reason: 'WS_DISCONNECT' })
      noteDisconnect()
    })
  })

  setInterval(() => {
    for (const socket of io.sockets.sockets.values()) {
      if (!socket.data.session) continue
      const nonce = `${Date.now()}-${socket.id}`
      const roomKey = `room:${socket.data.session.roomId}`
      redis.hmget(roomKey, 'eventSeq', 'status').then(([eventSeq, status]) => {
        if (socket.data.session) {
          socket.emit('ping', {
            serverTime: Date.now(),
            nonce,
            eventSeq: Number(eventSeq) || 0,
            status: status || null,
          })
        }
      }).catch((error) => logger.error(`ping failed message=${error.message}`))
    }
  }, HEARTBEAT_MS)

  setInterval(() => {
    const now = Date.now()
    for (const socket of io.sockets.sockets.values()) {
      if (!socket.data.session) continue
      if (now - (socket.data.lastPongAt || 0) <= HEARTBEAT_TIMEOUT_MS) continue
      logger.warn(`presence heartbeat-timeout roomId=${socket.data.session.roomId} playerId=${socket.data.session.playerId}`)
      socket.disconnect(true)
    }
  }, 5_000)

  setInterval(() => {
    sweepGrace().catch((error) => logger.error(`grace sweep failed message=${error.message}`))
    sweepZombies(io).catch((error) => logger.error(`zombie sweep failed message=${error.message}`))
  }, 1_000)
}

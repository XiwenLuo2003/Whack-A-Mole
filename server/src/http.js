import crypto from 'crypto'
import express from 'express'
import { redis } from './redis.js'
import { logger } from './logger.js'
import { send } from './httpUtil.js'
import { joinRoom, readSnapshot } from './roomStore.js'
import { verifyToken } from './token.js'
import { getIo } from './broadcast.js'
import { removePlayer } from './lifecycle.js'
import { readMetrics } from './metrics.js'

export function createHttpApp() {
  const app = express()
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    return next()
  })
  app.use((req, res, next) => {
    req.requestId = req.get('x-request-id') || crypto.randomUUID()
    return next()
  })
  app.use(express.json({ limit: '16kb' }))
  app.use((error, req, res, next) => {
    const requestId = req.requestId || crypto.randomUUID()
    req.requestId = requestId
    if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
      const code = error.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON'
      const message = code === 'PAYLOAD_TOO_LARGE' ? '请求体过大' : '请求体不是合法 JSON'
      logger.debug(`[IN ] http ${req.method} ${req.originalUrl} requestId=${requestId}`)
      send(res, code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, {
        success: false,
        error: { code, message },
      })
      logger.debug(`[OUT] http ${req.method} ${req.originalUrl} requestId=${requestId} status=${res.statusCode} code=${code}`)
      return undefined
    }
    return next(error)
  })
  app.use((req, res, next) => {
    req.requestId = req.requestId || req.get('x-request-id') || crypto.randomUUID()
    const started = Date.now()
    if (req.path === '/api/rooms/join') {
      const roomCode = req.body?.roomCode ?? ''
      const nickname = String(req.body?.nickname ?? '').slice(0, 40)
      logger.debug(`[IN ] http POST /api/rooms/join requestId=${req.requestId} roomCode=${roomCode} nickname=${nickname}`)
    } else {
      logger.debug(`[IN ] http ${req.method} ${req.originalUrl} requestId=${req.requestId}`)
    }
    res.on('finish', () => {
      logger.debug(`[OUT] http ${req.method} ${req.originalUrl} requestId=${req.requestId} status=${res.statusCode} code=${res.locals.errorCode || 'OK'} cost=${Date.now() - started}ms`)
    })
    next()
  })

  app.get('/api/health', async (req, res) => {
    try {
      const value = `${Date.now()}-${crypto.randomUUID()}`
      const key = `health:ping:${value}`
      await redis.set(key, '1', 'EX', 5)
      const read = await redis.get(key)
      await redis.del(key)
      if (read !== '1') throw new Error('redis read mismatch')
      return send(res, 200, { success: true, data: { redis: 'ok' } })
    } catch (error) {
      logger.error(`health check failed message=${error.message}`)
      return send(res, 503, {
        success: false,
        error: { code: 'REDIS_UNAVAILABLE', message: 'Redis 不可用' },
      })
    }
  })

  app.post('/api/rooms/join', async (req, res) => {
    try {
      const result = await joinRoom({
        roomCode: req.body?.roomCode,
        nickname: req.body?.nickname,
        requestId: req.requestId,
      })
      return send(res, result.http, {
        success: result.http < 400,
        data: result.data ?? null,
        error: result.error ?? null,
      })
    } catch (error) {
      logger.error(`join failed requestId=${req.requestId} message=${error.message}`)
      return send(res, 500, {
        success: false,
        error: { code: 'INTERNAL', message: '服务内部错误' },
      })
    }
  })

  function authorize(req, res, roomId) {
    const header = req.get('authorization') || ''
    const match = header.match(/^Bearer\s+(.+)$/i)
    if (!match) {
      send(res, 401, { success: false, error: { code: 'UNAUTHORIZED', message: '缺少令牌' } })
      return null
    }
    const session = verifyToken(match[1].trim())
    if (!session) {
      send(res, 401, { success: false, error: { code: 'UNAUTHORIZED', message: '令牌无效' } })
      return null
    }
    if (session.roomId !== roomId) {
      send(res, 403, { success: false, error: { code: 'ROOM_MISMATCH', message: '令牌与房间不一致' } })
      return null
    }
    return session
  }

  app.get('/api/rooms/:roomId', async (req, res) => {
    const session = authorize(req, res, req.params.roomId)
    if (!session) return undefined
    const snapshot = await readSnapshot(session.roomId)
    if (!snapshot) {
      return send(res, 404, { success: false, error: { code: 'ROOM_CLOSED', message: '房间不存在' } })
    }
    return send(res, 200, { success: true, data: snapshot, error: null })
  })

  app.post('/api/rooms/:roomId/leave', async (req, res) => {
    const session = authorize(req, res, req.params.roomId)
    if (!session) return undefined
    const result = await removePlayer({
      roomId: session.roomId,
      playerId: session.playerId,
      reason: 'LEAVE',
    })
    if (result.removed) {
      const io = getIo()
      if (io) {
        const sockets = await io.in(session.roomId).fetchSockets()
        for (const socket of sockets) {
          if (socket.data.session?.playerId === session.playerId) socket.disconnect(true)
        }
      }
    }
    return send(res, 200, {
      success: true,
      data: { left: Boolean(result.removed), playerCount: result.playerCount },
      error: null,
    })
  })

  app.get('/api/metrics', async (req, res) => {
    const data = await readMetrics()
    return send(res, 200, { success: true, data, error: null })
  })

  app.use('/api', (req, res) => {
    send(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '接口不存在' } })
  })
  return app
}

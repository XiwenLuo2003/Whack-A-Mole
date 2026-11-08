import { logger } from './logger.js'

let io = null

export function setIo(value) {
  io = value
}

export function getIo() {
  return io
}

export function emit(roomId, event, eventSeq, fields) {
  const payload = {
    roomId,
    eventSeq,
    serverTime: Date.now(),
    ...fields,
  }
  const detail = Object.entries(fields)
    .filter(([, value]) => value == null || ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => `${key}=${value ?? '-'}`)
    .join(' ')
  logger.debug(`[OUT] ws   ${event} eventSeq=${eventSeq} roomId=${roomId} ${detail}`.trim())
  if (!io) {
    logger.error(`broadcast skipped event=${event} roomId=${roomId} reason=NO_IO`)
    return payload
  }
  io.to(roomId).emit(event, payload)
  return payload
}

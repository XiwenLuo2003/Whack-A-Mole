import Redis from 'ioredis'
import { config } from './config.js'
import { logger } from './logger.js'

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 2,
  connectTimeout: 2000,
  enableReadyCheck: true,
})

redis.on('error', (error) => {
  logger.error(`redis error message=${error.message}`)
})

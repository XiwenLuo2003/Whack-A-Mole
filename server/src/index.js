import { createServer } from 'http'
import { Server } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { config } from './config.js'
import { logger } from './logger.js'
import { redis } from './redis.js'
import { createHttpApp } from './http.js'
import { attachSocket } from './ws.js'
import { setIo } from './broadcast.js'
import { startGameLoop } from './gameLoop.js'
import { instanceId } from './lease.js'

const app = createHttpApp()
const server = createServer(app)
const io = new Server(server, {
  path: '/ws',
  cors: { origin: '*' },
  maxHttpBufferSize: 16 * 1024,
})
const pub = redis.duplicate()
const sub = redis.duplicate()
pub.on('error', (error) => logger.error(`redis pub message=${error.message}`))
sub.on('error', (error) => logger.error(`redis sub message=${error.message}`))

try {
  const pong = await redis.ping()
  await pub.ping()
  logger.info(`redis connected pong=${pong}`)
} catch (error) {
  logger.error(`redis unavailable at startup message=${error.message}`)
  process.exit(1)
}

io.adapter(createAdapter(pub, sub))
setIo(io)
attachSocket(io)
startGameLoop()
logger.info(`instance id=${instanceId} broadcast=redis-adapter`)

server.listen(config.port, () => {
  logger.info(`http listening port=${config.port}`)
})

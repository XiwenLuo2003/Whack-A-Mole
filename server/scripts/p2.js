import fs from 'fs'
import Redis from 'ioredis'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000'
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'
const LOG_FILE = process.env.LOG_FILE || ''
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const failures = []

function check(condition, message) {
  if (!condition) {
    failures.push(message)
    console.error(`FAIL ${message}`)
    return
  }
  console.log(`OK   ${message}`)
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options)
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  return { status: response.status, body }
}

async function join(roomCode, nickname) {
  return api('/api/rooms/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomCode, nickname }),
  })
}

async function authedGet(roomId, token) {
  return api(`/api/rooms/${roomId}`, { headers: { Authorization: `Bearer ${token}` } })
}

async function leave(roomId, token) {
  return api(`/api/rooms/${roomId}/leave`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
}

async function untilStatus(roomId, token, status, timeout = 8_000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    last = await authedGet(roomId, token)
    if (last.body?.data?.status === status) return last
    await sleep(150)
  }
  return last
}

function scoreSum(snapshot) {
  return (snapshot?.players || []).reduce((sum, player) => sum + Number(player.score || 0), 0)
}

async function dropRoom(redis, code) {
  const roomId = await redis.get(`roomcode:${code}`)
  if (!roomId) return
  const keys = [...(await redis.keys(`room:${roomId}*`)), ...(await redis.keys(`presence:${roomId}:*`))]
  if (keys.length) await redis.del(...keys)
  await redis.del(`roomcode:${code}`, `prepare-lock:${roomId}`, `loop-owner:${roomId}`)
  await redis.srem('rooms:live', roomId)
}

async function main() {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 })
  const rejected = await join('NO', '指标')
  check(rejected.status === 400, '非法加入仍返回 400')

  const leasePlayers = []
  for (const nickname of ['租一', '租二', '租三', '租四', '租五']) leasePlayers.push(await join('P2LEAS', nickname))
  const leaseId = leasePlayers[0].body.data.roomId
  check(leasePlayers[4].body.data.snapshot.status === 'COUNTDOWN', '满员后先进入 3 秒倒计时')
  await redis.set(`loop-owner:${leaseId}`, 'p2-other-instance', 'PX', 15_000)
  await sleep(4_000)
  const blocked = await authedGet(leaseId, leasePlayers[0].body.data.playerToken)
  check(blocked.body.data.status === 'COUNTDOWN', '未持有循环租约时不切换阶段、不生成金币')
  check(blocked.body.data.activeCoin == null, '租约被占用期间没有有效金币')
  await redis.del(`loop-owner:${leaseId}`)
  const taken = await untilStatus(leaseId, leasePlayers[0].body.data.playerToken, 'PLAYING', 3_000)
  const ends = taken.body.data.gameEndsAt
  const started = taken.body.data.gameStartedAt
  check(taken.body.data.status === 'PLAYING' && ends - started === 60_000, '租约释放后按 Redis 绝对时间进入 60 秒对局')
  let coinCount = 0
  for (let i = 0; i < 25 && coinCount === 0; i += 1) {
    await sleep(200)
    const snap = await authedGet(leaseId, leasePlayers[0].body.data.playerToken)
    if (snap.body.data.activeCoin?.status === 'ACTIVE') coinCount = 1
  }
  check(coinCount === 1, '接管后生成一枚有效金币，不会并发刷出第二枚')

  const timePlayers = []
  for (const nickname of ['时一', '时二', '时三', '时四', '时五']) timePlayers.push(await join('P2TIME', nickname))
  const timeId = timePlayers[0].body.data.roomId
  const playing = await untilStatus(timeId, timePlayers[0].body.data.playerToken, 'PLAYING', 8_000)
  const beforeScores = scoreSum(playing.body.data)
  const beforeEnds = playing.body.data.gameEndsAt
  await redis.hset(`room:${timeId}`, 'gameEndsAt', String(Date.now() - 30))
  const finished = await untilStatus(timeId, timePlayers[0].body.data.playerToken, 'FINISHED', 3_000)
  await sleep(400)
  const settled = await authedGet(timeId, timePlayers[0].body.data.playerToken)
  check(finished.body.data.status === 'FINISHED' && settled.body.data.status === 'FINISHED', '到期后按 Redis 的 gameEndsAt 结算，而不是内存定时器')
  check(scoreSum(settled.body.data) === beforeScores && settled.body.data.activeCoin == null, 'FINISHED 之后分数和金币不再变化')
  check(beforeEnds > Date.now(), '测试改写的是已保存的截止时间，原对局时长本身仍是 60 秒')
  if (LOG_FILE && fs.existsSync(LOG_FILE)) {
    const log = fs.readFileSync(LOG_FILE, 'utf8')
    check(log.includes(`archive failed roomId=${timeId} reason=POSTGRES_UNAVAILABLE`), '数据库不可用时记录错误且不回滚对局')
    check(!log.includes(timePlayers[0].body.data.playerToken), '观测日志没有打印完整令牌')
  } else {
    check(false, '没有找到服务日志文件')
  }

  const closers = []
  for (const nickname of ['关甲', '关乙', '关丙', '关丁', '关戊']) closers.push(await join('P2CLOS', nickname))
  const closeId = closers[0].body.data.roomId
  await untilStatus(closeId, closers[0].body.data.playerToken, 'PLAYING', 8_000)
  for (const player of closers) await leave(closeId, player.body.data.playerToken)
  const closed = await authedGet(closeId, closers[0].body.data.playerToken)
  const ttl = await redis.ttl(`room:${closeId}`)
  const again = await join('P2CLOS', '关己')
  check(closed.body.success === true && closed.body.data.status === 'CLOSED' && closed.body.data.playerCount === 0, '全员离开后可以查询关闭终态')
  check(ttl > 0 && ttl <= 600, `关闭后的房间键保留 10 分钟，实际 TTL ${ttl}s`)
  check(again.status === 409 && again.body.error?.code === 'ROOM_CLOSED', '保留期内同一房间号仍然返回 ROOM_CLOSED')

  const metrics = await api('/api/metrics')
  const data = metrics.body?.data || {}
  check(metrics.status === 200 && metrics.body.success === true && metrics.body.error == null && typeof metrics.body.serverTime === 'number', '指标接口使用统一响应')
  check(Number.isInteger(data.onlineRooms) && data.joinRejected >= 1, '可查询在线房间数和加入拒绝数')
  check(data.claimSuccessRate >= 0 && data.claimSuccessRate <= 1, '可查询抢占成功率')
  check(data.duplicateClickRate >= 0 && data.duplicateClickRate <= 1, '可查询重复点击率')
  check(data.disconnectRate >= 0 && typeof data.loopDriftMs === 'number' && typeof data.luaMs === 'number', '可查询断线率、循环漂移和 Lua 耗时')

  for (const code of ['P2LEAS', 'P2TIME', 'P2CLOS']) await dropRoom(redis, code)
  await redis.quit()
  if (failures.length) {
    console.error(`P2 检查失败 ${failures.length} 项`)
    process.exit(1)
  }
  console.log('P2 检查通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

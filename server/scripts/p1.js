import crypto from 'crypto'
import Redis from 'ioredis'
import { io } from 'socket.io-client'
import { createClientState, reduce, visibleCoin } from '../../web/src/gameState.js'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000'
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'
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

function assertReducer() {
  let state = reduce(createClientState(), {
    type: 'join',
    now: 2_000,
    serverTime: 1_000,
    roomCode: 'P1SYNC',
    data: {
      playerId: 'p1',
      roomId: 'room-1',
      snapshot: {
        status: 'PLAYING',
        deadlineAt: 62_000,
        eventSeq: 2,
        playerCount: 2,
        players: [
          { playerId: 'p1', nickname: '甲', score: 1, joinedAt: 1 },
          { playerId: 'p2', nickname: '乙', score: 0, joinedAt: 2 },
        ],
        activeCoin: null,
      },
    },
  }).state
  check(state.clockOffset === -1_000 && state.roomId === 'room-1', '首次采样写入 clockOffset 和 roomId')
  const better = reduce(state, {
    type: 'event',
    name: 'game.started',
    now: 3_000,
    payload: { eventSeq: 3, startedAt: 2_900, gameEndsAt: 62_900, serverTime: 2_900 },
  })
  check(better.state.clockOffset === -100, '低延迟样本（更大的 offset）覆盖更差的样本')
  const worse = reduce(better.state, {
    type: 'clock',
    now: 5_000,
    serverTime: 3_000,
  })
  check(worse.state.clockOffset === -100, '更高延迟的样本不会把时钟偏移拉低')
  const jumped = reduce(better.state, {
    type: 'event',
    name: 'score.updated',
    now: 3_100,
    payload: { eventSeq: 6, playerId: 'p1', score: 2, rank: 1, serverTime: 3_000 },
  })
  check(jumped.sync === true && jumped.syncFrom === 3 && jumped.state.players[0].score === 2, '序号跳跃标记 room.sync 并仍应用权威积分')
  const late = reduce(better.state, {
    type: 'event',
    name: 'coin.spawned',
    now: 20_000,
    payload: { eventSeq: 4, coinId: 'old', row: 0, col: 0, spawnedAt: 1_000, expiresAt: 2_000, serverTime: 19_900 },
  })
  check(late.state.activeCoin == null && visibleCoin(late.state, 20_000) == null, '过期金币不渲染也不可点击')
  const left = reduce(better.state, {
    type: 'event',
    name: 'player.left',
    now: 3_200,
    payload: { eventSeq: 4, playerId: 'p2', reason: 'LEAVE', playerCount: 1, serverTime: 3_100 },
  })
  check(left.state.players.length === 1 && left.state.playerCount === 1 && left.state.screen === 'room', '其他人离开时只减人数')
  const selfLeft = reduce(better.state, {
    type: 'event',
    name: 'player.left',
    now: 3_200,
    payload: { eventSeq: 4, playerId: 'p1', reason: 'LEAVE', playerCount: 1, serverTime: 3_100 },
  })
  check(selfLeft.selfLeft === true && selfLeft.state.screen === 'lobby', '自己离开后回到大厅')
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

function collect(socket) {
  const names = ['room.snapshot', 'player.joined', 'player.left', 'game.countdown', 'game.started', 'coin.spawned', 'coin.removed', 'coin.claimed', 'score.updated', 'game.finished', 'room.error', 'ping']
  const box = { events: [] }
  for (const name of names) {
    socket.on(name, (payload) => {
      box.events.push({ name, payload })
    })
  }
  box.waitFor = (name, pred, timeout = 8_000, afterIndex = 0) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${name} 超时`)), timeout)
    const tick = () => {
      const found = box.events.slice(afterIndex).find((event) => event.name === name && pred(event.payload))
      if (found) {
        clearTimeout(timer)
        resolve(found.payload)
        return
      }
      setTimeout(tick, 30)
    }
    tick()
  })
  return box
}

function connect(token) {
  const socket = io(BASE, { path: '/ws', transports: ['websocket'], forceNew: true, autoConnect: false })
  const box = collect(socket)
  socket.on('ping', (payload) => socket.emit('pong', { nonce: payload?.nonce }))
  socket.connect()
  socket.on('connect', () => socket.emit('room.resume', { playerToken: token }))
  return box.waitFor('room.snapshot', () => true, 8_000).then((snap) => ({ socket, box, snap }))
}

function claim(socket, coinId, requestId = crypto.randomUUID(), clickedAt = Date.now()) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('claim 超时')), 5_000)
    socket.emit('coin.claim', { coinId, requestId, clickedAt }, (ack) => {
      clearTimeout(timer)
      resolve(ack)
    })
  })
}

async function roomOf(redis, code) {
  const roomId = await redis.get(`roomcode:${code}`)
  if (!roomId) throw new Error(`房间 ${code} 不存在`)
  return roomId
}

async function authedGet(roomId, token) {
  return api(`/api/rooms/${roomId}`, { headers: { Authorization: `Bearer ${token}` } })
}

async function leave(roomId, token) {
  return api(`/api/rooms/${roomId}/leave`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
}

async function dropRoom(redis, code) {
  const roomId = await redis.get(`roomcode:${code}`)
  if (!roomId) return
  const keys = [
    ...(await redis.keys(`room:${roomId}*`)),
    ...(await redis.keys(`claim:${roomId}:*`)),
    ...(await redis.keys(`presence:${roomId}:*`)),
  ]
  if (keys.length) await redis.del(...keys)
  await redis.del(`roomcode:${code}`, `prepare-lock:${roomId}`)
  await redis.srem('rooms:live', roomId)
}

async function main() {
  assertReducer()
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 })
  const badJson = await api('/api/rooms/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  })
  check(badJson.status === 400 && badJson.body?.error?.code === 'INVALID_JSON' && badJson.body.success === false, '非法 JSON 返回 400 INVALID_JSON')
  const huge = await api('/api/rooms/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomCode: 'P1HUGE', nickname: '名'.repeat(20_000) }),
  })
  check(huge.status === 413 && huge.body?.error?.code === 'PAYLOAD_TOO_LARGE' && typeof huge.body?.serverTime === 'number', '超大 body 返回 413 且带 serverTime')
  const health = await api('/api/health')
  check(health.status === 200 && health.body.success === true, '非法请求之后进程仍可响应')

  const first = await join('P1LIFE', '甲')
  const second = await join('P1LIFE', '乙')
  check(first.status === 200 && second.status === 200, '准备房间两人加入成功')
  const lifeId = first.body.data.roomId
  const deadline = first.body.data.snapshot.deadlineAt
  const watcher = await connect(first.body.data.playerToken)
  const extra = await connect(first.body.data.playerToken)
  extra.socket.disconnect()
  await sleep(400)
  const still = await authedGet(lifeId, first.body.data.playerToken)
  const me = still.body.data.players.find((player) => player.playerId === first.body.data.playerId)
  check(still.body.data.playerCount === 2 && me.connectionState === 'ONLINE', '同一玩家还有连接时，断开多余连接不进入宽限')
  const mark = watcher.box.events.length
  const left = await leave(lifeId, second.body.data.playerToken)
  check(left.status === 200 && left.body.success === true && left.body.data.left === true && left.body.data.playerCount === 1 && left.body.error == null, '主动退出返回统一成功包且人数减一')
  const leftEvent = await watcher.box.waitFor('player.left', (payload) => payload.playerId === second.body.data.playerId, 3_000, mark)
  check(leftEvent.reason === 'LEAVE' && leftEvent.playerCount === 1 && leftEvent.roomId === lifeId && typeof leftEvent.eventSeq === 'number', 'player.left 带 reason、人数、房间和序号')
  const again = await leave(lifeId, second.body.data.playerToken)
  await sleep(300)
  const leftCount = watcher.box.events.filter((event) => event.name === 'player.left' && event.payload.playerId === second.body.data.playerId).length
  const afterLeave = await authedGet(lifeId, first.body.data.playerToken)
  check(again.status === 200 && again.body.success === true && again.body.data.playerCount === 1, '重复退出仍返回成功且人数不变')
  check(leftCount === 1 && afterLeave.body.data.playerCount === 1, '重复退出不重复广播，人数不为负')
  check(afterLeave.body.data.status === 'PREPARING' && afterLeave.body.data.deadlineAt === deadline, '准备阶段有人离开后倒计时截止时间不变且不关闭')
  const noToken = await api(`/api/rooms/${lifeId}`)
  const wrongRoom = await authedGet('11111111-1111-1111-1111-111111111111', first.body.data.playerToken)
  check(noToken.status === 401 && noToken.body.error?.code === 'UNAUTHORIZED', '快照接口缺少令牌返回 401')
  check(wrongRoom.status === 403 && wrongRoom.body.error?.code === 'ROOM_MISMATCH', '令牌房间与路径不一致返回 403')
  watcher.socket.disconnect()

  const players = []
  for (const nickname of ['一', '二', '三', '四', '五']) players.push(await join('P1PLAY', nickname))
  check(players.every((item, index) => item.status === (index < 5 ? 200 : 0)) && players[4].body.data.snapshot.status === 'COUNTDOWN', '五人房间满员进入倒计时')
  const playId = players[0].body.data.roomId
  const alpha = await connect(players[0].body.data.playerToken)
  const beta = await connect(players[1].body.data.playerToken)
  let playing = null
  for (let i = 0; i < 40 && playing?.body?.data?.status !== 'PLAYING'; i += 1) {
    await sleep(200)
    playing = await authedGet(playId, players[0].body.data.playerToken)
  }
  check(playing.body.success === true && playing.body.data.status === 'PLAYING' && Array.isArray(playing.body.data.players) && playing.body.data.scores && 'activeCoin' in playing.body.data && typeof playing.body.data.deadlineAt === 'number', 'GET 房间返回状态、截止时间、玩家、积分和金币字段')
  let coin = null
  let won = null
  const requestId = crypto.randomUUID()
  for (let attempt = 0; attempt < 5 && !won?.accepted; attempt += 1) {
    coin = null
    for (let i = 0; i < 25 && !coin; i += 1) {
      await sleep(200)
      coin = (await authedGet(playId, players[0].body.data.playerToken)).body.data.activeCoin
    }
    if (!coin) break
    const attemptId = attempt === 0 ? requestId : crypto.randomUUID()
    won = await claim(beta.socket, coin.coinId, attemptId, Date.now() + 60_000)
    if (won.accepted) won.requestId = attemptId
  }
  check(won?.accepted === true && won.winnerId === players[1].body.data.playerId && won.reason == null && typeof won.serverTime === 'number', '抢中回执包含 requestId、accepted、winnerId、serverTime')
  let scoreBurst = 0
  if (coin && won?.accepted) {
  const usedRequestId = won.requestId || requestId
  const winnerBefore = await redis.get(`claim:${playId}:${coin.coinId}`)
  const scoreBefore = (await authedGet(playId, players[0].body.data.playerToken)).body.data.players.find((player) => player.playerId === players[1].body.data.playerId).score
  const replay = await claim(beta.socket, coin.coinId, usedRequestId, 1)
  const winnerAfter = await redis.get(`claim:${playId}:${coin.coinId}`)
  const scoreAfter = (await authedGet(playId, players[0].body.data.playerToken)).body.data.players.find((player) => player.playerId === players[1].body.data.playerId).score
  check(replay.accepted === true && replay.winnerId === won.winnerId && scoreAfter === scoreBefore && winnerAfter === winnerBefore, '同一 requestId 重放返回首次回执且不改分数和获胜者')
  const other = await claim(beta.socket, coin.coinId, crypto.randomUUID(), 1)
  const scoreOther = (await authedGet(playId, players[0].body.data.playerToken)).body.data.players.find((player) => player.playerId === players[1].body.data.playerId).score
  check(other.accepted === false && other.reason === 'ALREADY_CLAIMED' && scoreOther === scoreBefore, '不同 requestId 抢已领取金币返回 ALREADY_CLAIMED')
  const missing = await new Promise((resolve) => {
    beta.socket.emit('coin.claim', { requestId: crypto.randomUUID() }, resolve)
  })
  check(missing.accepted === false && missing.reason === 'INVALID_COIN' && scoreOther === scoreBefore, '缺少 coinId 时拒绝且不改分')
  const burst = await Promise.all(Array.from({ length: 70 }, () => claim(beta.socket, `missing-${crypto.randomUUID()}`)))
  const limited = burst.filter((ack) => ack.reason === 'RATE_LIMITED').length
  scoreBurst = (await authedGet(playId, players[0].body.data.playerToken)).body.data.players.find((player) => player.playerId === players[1].body.data.playerId).score
  check(limited > 0 && scoreBurst === scoreBefore, `超过频率上限会 RATE_LIMITED 且不加分，实际限制 ${limited} 次`)
  }

  const beforeDrop = await authedGet(playId, players[0].body.data.playerToken)
  beta.socket.disconnect()
  await sleep(400)
  const during = await authedGet(playId, players[0].body.data.playerToken)
  const reconnecting = during.body.data.players.find((player) => player.playerId === players[1].body.data.playerId)
  check(during.body.data.playerCount === beforeDrop.body.data.playerCount && reconnecting.connectionState === 'RECONNECTING' && reconnecting.score === scoreBurst, '断线后 10 秒内人数和积分不变，状态为 RECONNECTING')
  const back = await connect(players[1].body.data.playerToken)
  const restored = (await authedGet(playId, players[0].body.data.playerToken)).body.data.players.find((player) => player.playerId === players[1].body.data.playerId)
  check(restored.connectionState === 'ONLINE' && restored.score === scoreBurst && restored.nickname === '二', '宽限期内重连恢复原昵称、积分和在线状态')
  const leftMark = alpha.box.events.length
  back.socket.disconnect()
  const timedOut = await alpha.box.waitFor('player.left', (payload) => payload.playerId === players[1].body.data.playerId && payload.reason === 'GRACE_TIMEOUT', 13_000, leftMark)
  const freed = await authedGet(playId, players[0].body.data.playerToken)
  check(timedOut.playerCount === beforeDrop.body.data.playerCount - 1 && !freed.body.data.players.some((player) => player.playerId === players[1].body.data.playerId), '超过 10 秒后释放席位并广播 GRACE_TIMEOUT')
  const denied = io(BASE, { path: '/ws', transports: ['websocket'], forceNew: true })
  const deniedBox = collect(denied)
  denied.on('connect', () => denied.emit('room.resume', { playerToken: players[1].body.data.playerToken }))
  const deniedError = await deniedBox.waitFor('room.error', () => true, 4_000)
  check(deniedError.code === 'PLAYER_NOT_ACTIVE', '宽限期结束后原令牌不能再占席位')
  denied.disconnect()
  const syncMark = alpha.box.events.length
  alpha.socket.emit('room.sync', { lastEventSeq: 0 })
  const synced = await alpha.box.waitFor('room.snapshot', (payload) => payload.roomId === playId, 3_000, syncMark)
  check(synced.status === 'PLAYING' && Array.isArray(synced.players) && 'activeCoin' in synced, 'room.sync 只回当前连接的权威快照')
  await alpha.box.waitFor('ping', (payload) => typeof payload.serverTime === 'number' && payload.nonce, 12_000)
  check(true, '10 秒内心跳 ping 到达')
  alpha.socket.disconnect()

  const closers = []
  for (const nickname of ['关一', '关二', '关三', '关四', '关五']) closers.push(await join('P1CLOS', nickname))
  const closeId = closers[0].body.data.roomId
  let closedPlaying = null
  for (let i = 0; i < 40 && closedPlaying?.body?.data?.status !== 'PLAYING'; i += 1) {
    await sleep(200)
    closedPlaying = await authedGet(closeId, closers[0].body.data.playerToken)
  }
  check(closedPlaying.body.data.status === 'PLAYING', '全员退出测试已进入对局')
  for (const player of closers) await leave(closeId, player.body.data.playerToken)
  const closed = await authedGet(closeId, closers[0].body.data.playerToken)
  const live = await redis.sismember('rooms:live', closeId)
  check(closed.body.data.status === 'CLOSED' && closed.body.data.playerCount === 0 && live === 0, '对局中全员离开后房间关闭并停止循环')

  const zombieJoin = await join('P1ZOMB', '僵尸')
  const zombieId = zombieJoin.body.data.roomId
  const zombie = await connect(zombieJoin.body.data.playerToken)
  zombie.socket.disconnect()
  const member = `${zombieId}:${zombieJoin.body.data.playerId}`
  for (let i = 0; i < 20; i += 1) {
    const raw = await redis.hget(`room:${zombieId}:players`, zombieJoin.body.data.playerId)
    if (raw && JSON.parse(raw).connectionState === 'RECONNECTING') break
    await sleep(100)
  }
  await redis.zrem('grace:index', member)
  const rawPlayer = await redis.hget(`room:${zombieId}:players`, zombieJoin.body.data.playerId)
  const player = JSON.parse(rawPlayer)
  player.connectionState = 'ONLINE'
  player.connectedOnce = 1
  await redis.hset(`room:${zombieId}:players`, zombieJoin.body.data.playerId, JSON.stringify(player))
  await redis.del(`presence:${zombieId}:${zombieJoin.body.data.playerId}`)
  let gone = false
  for (let i = 0; i < 20; i += 1) {
    await sleep(200)
    gone = !(await redis.hexists(`room:${zombieId}:players`, zombieJoin.body.data.playerId))
    if (gone) break
  }
  check(gone, '在线记录过期且连接已不在时按 ZOMBIE 移除')

  const crowd = []
  for (let index = 0; index < 5; index += 1) crowd.push(await join('P1REG1', `回归${index}`))
  const sixth = await join('P1REG1', '回归满')
  check(crowd.every((item) => item.status === 200) && sixth.status === 409 && sixth.body.error?.code === 'ROOM_FULL', '回归：第 6 人仍然 ROOM_FULL')
  const regId = crowd[0].body.data.roomId
  const regA = await connect(crowd[0].body.data.playerToken)
  const regB = await connect(crowd[1].body.data.playerToken)
  let regCoin = null
  for (let i = 0; i < 40 && !regCoin; i += 1) {
    await sleep(200)
    regCoin = (await authedGet(regId, crowd[0].body.data.playerToken)).body.data.activeCoin
  }
  const acks = await Promise.all([
    ...Array.from({ length: 20 }, () => claim(regA.socket, regCoin.coinId)),
    ...Array.from({ length: 20 }, () => claim(regB.socket, regCoin.coinId)),
  ])
  const total = (await authedGet(regId, crowd[0].body.data.playerToken)).body.data.players.reduce((sum, player) => sum + player.score, 0)
  check(acks.filter((ack) => ack.accepted).length === 1 && total === 1, '回归：并发抢币仍然只有 1 次成功且总分 +1')
  regA.socket.disconnect()
  regB.socket.disconnect()

  for (const code of ['P1LIFE', 'P1PLAY', 'P1CLOS', 'P1ZOMB', 'P1REG1']) await dropRoom(redis, code)
  await redis.quit()
  if (failures.length) {
    console.error(`P1 检查失败 ${failures.length} 项`)
    process.exit(1)
  }
  console.log('P1 检查通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

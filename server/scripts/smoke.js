import crypto from 'crypto'
import fs from 'fs'
import Redis from 'ioredis'
import { io } from 'socket.io-client'
import { createClientState, displaySeconds, reduce } from '../../web/src/gameState.js'

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

function assertClient() {
  let state = createClientState()
  const joined = reduce(state, {
    type: 'join',
    now: 1_000,
    serverTime: 1_000,
    roomCode: 'ABCDEF',
    data: {
      playerId: 'p1',
      snapshot: {
        status: 'PREPARING',
        deadlineAt: 31_000,
        eventSeq: 2,
        playerCount: 1,
        players: [{ playerId: 'p1', nickname: 'A', score: 0, joinedAt: 1 }],
        activeCoin: null,
      },
    },
  })
  state = joined.state
  check(state.screen === 'room' && displaySeconds(state, 1_000) === 30, '客户端准备倒计时从 deadlineAt 计算')
  state = reduce(state, {
    type: 'event',
    name: 'game.countdown',
    now: 2_000,
    payload: { eventSeq: 3, phase: 'COUNTDOWN', deadlineAt: 5_000, serverTime: 2_000 },
  }).state
  check(state.status === 'COUNTDOWN' && state.deadlineAt === 5_000, '满员后倒计时改用新的 3 秒 deadlineAt')
  state = reduce(state, {
    type: 'event',
    name: 'game.started',
    now: 5_000,
    payload: { eventSeq: 4, startedAt: 5_000, gameEndsAt: 65_000, serverTime: 5_000 },
  }).state
  check(state.status === 'PLAYING' && state.deadlineAt === 65_000, '开局后顶部倒计时改为 gameEndsAt')
  state = reduce(state, {
    type: 'event',
    name: 'coin.spawned',
    now: 6_000,
    payload: { eventSeq: 5, coinId: 'c1', row: 1, col: 2, spawnedAt: 6_000, expiresAt: 9_000, serverTime: 6_000 },
  }).state
  const click = reduce(state, { type: 'claim-click', coinId: 'c1', now: 6_100 })
  check(click.emit && click.state.players[0].score === 0, '点击只锁定金币，不改积分')
  check(!reduce(click.state, { type: 'claim-click', coinId: 'c1', now: 6_500 }).emit, '1 秒内忽略同一金币的后续点击')
  const accepted = reduce(click.state, { type: 'claim-ack', ack: { accepted: true }, now: 6_600 })
  check(accepted.state.players[0].score === 0 && accepted.state.fx?.mode === 'break', '抢中回执保留动画且不加分')
  const scored = reduce(accepted.state, {
    type: 'event',
    name: 'score.updated',
    now: 6_700,
    payload: { eventSeq: 7, playerId: 'p1', score: 1, rank: 1, serverTime: 6_700 },
  })
  check(scored.state.players[0].score === 1, '积分只在 score.updated 后变化')
  const rolled = reduce(click.state, { type: 'claim-ack', ack: { accepted: false, reason: 'INVALID_COIN' }, now: 6_600 })
  check(rolled.state.fx == null && rolled.state.players[0].score === 0, '失败且金币仍有效时回滚动画')
  const taken = reduce(click.state, { type: 'claim-ack', ack: { accepted: false, reason: 'ALREADY_CLAIMED' }, now: 6_600 })
  check(taken.state.fx?.mode === 'gone', '金币被他人抢走后保持消失')
  let retry = reduce(accepted.state, { type: 'fx-clear', coinId: 'c1' }).state
  check(!reduce(retry, { type: 'claim-click', coinId: 'c1', now: 6_800 }).emit, '回执之后 1 秒内仍然不重发')
  check(reduce(retry, { type: 'claim-click', coinId: 'c1', now: 7_100 }).emit, '超过 1 秒且金币仍在时可以再次发送')
  const late = reduce(state, {
    type: 'event',
    name: 'coin.spawned',
    now: 20_000,
    payload: { eventSeq: 8, coinId: 'old', row: 0, col: 0, spawnedAt: 1_000, expiresAt: 2_000, serverTime: 1_500 },
  })
  check(late.state.activeCoin == null, '过期金币到达后不渲染')
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
  const names = ['room.snapshot', 'player.joined', 'game.countdown', 'game.started', 'coin.spawned', 'coin.removed', 'coin.claimed', 'score.updated', 'game.finished', 'room.error']
  const events = []
  const waiters = []
  for (const name of names) {
    socket.on(name, (payload) => {
      events.push({ name, payload })
      for (const waiter of [...waiters]) waiter()
    })
  }
  return {
    events,
    waitFor(name, predicate = () => true, timeout = 8_000, after = 0) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待超时 ${name}`)), timeout)
        const check = () => {
          const found = events.find((event, index) => index >= after && event.name === name && predicate(event.payload))
          if (!found) return
          clearTimeout(timer)
          resolve(found.payload)
        }
        waiters.push(check)
        check()
      })
    },
  }
}

function connect(token) {
  const socket = io(BASE, { path: '/ws', transports: ['websocket'], forceNew: true, autoConnect: false })
  const box = collect(socket)
  socket.connect()
  socket.on('ping', (payload) => socket.emit('pong', { nonce: payload?.nonce }))
  socket.on('connect', () => socket.emit('room.resume', { playerToken: token }))
  return box.waitFor('room.snapshot', () => true, 8_000).then((snap) => ({ socket, box, snap }))
}

function claim(socket, coinId, clickedAt = Date.now()) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('claim 超时')), 5_000)
    socket.emit('coin.claim', { coinId, requestId: crypto.randomUUID(), clickedAt }, (ack) => {
      clearTimeout(timer)
      resolve(ack)
    })
  })
}

async function cleanup(redis) {
  const keys = [
    ...(await redis.keys('room*')),
    ...(await redis.keys('claim:*')),
    ...(await redis.keys('prepare-lock:*')),
  ]
  if (keys.length) await redis.del(...keys)
}

async function waitReady() {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    try {
      const health = await api('/api/health')
      if (health.status === 200 && health.body?.success && health.body.serverTime) return health
    } catch { /* server still booting */ }
    await sleep(200)
  }
  throw new Error('服务未就绪')
}

async function scenarioFast() {
  const first = await join('FAST01', '玩家A')
  check(first.status === 200 && first.body.data.snapshot.status === 'PREPARING', '首人加入进入 PREPARING')
  const prepareGap = first.body.data.snapshot.deadlineAt - first.body.serverTime
  check(prepareGap > 29_000 && prepareGap <= 30_000, `准备倒计时约为 30 秒，实际 ${prepareGap}ms`)
  const alpha = await connect(first.body.data.playerToken)
  const second = await join('FAST01', '玩家B')
  check(second.body.data.snapshot.status === 'PREPARING', '第二人加入后仍在准备')
  check(second.body.data.snapshot.deadlineAt === first.body.data.snapshot.deadlineAt, '未满员时不重置 30 秒截止时间')
  const joined = await alpha.box.waitFor('player.joined', (payload) => payload.player?.nickname === '玩家B')
  check(joined.playerCount === 2, '房内收到 player.joined')
  await join('FAST01', '玩家C')
  await join('FAST01', '玩家D')
  const fifth = await join('FAST01', '玩家E')
  const countdownGap = fifth.body.data.snapshot.deadlineAt - fifth.body.serverTime
  check(fifth.body.data.snapshot.status === 'COUNTDOWN' && countdownGap > 2_000 && countdownGap <= 3_000, `第 5 人立即进入 3 秒倒计时，实际 ${countdownGap}ms`)
  await alpha.box.waitFor('game.countdown', (payload) => payload.phase === 'COUNTDOWN')
  const full = await join('FAST01', '玩家F')
  check(full.status === 409 && full.body.error?.code === 'ROOM_FULL', '第 6 人收到 ROOM_FULL')
  check(!alpha.box.events.some((event) => event.payload?.player?.nickname === '玩家F'), '满员拒绝不会广播第 6 人')
  const beta = await connect(second.body.data.playerToken)
  const started = await alpha.box.waitFor('game.started', () => true, 5_000)
  const startedIndex = alpha.box.events.findIndex((event) => event.name === 'game.started')
  check(started.gameEndsAt - started.startedAt === 60_000, '对局时长正好 60 秒')
  check(!alpha.box.events.slice(0, startedIndex).some((event) => event.name === 'coin.spawned'), '倒计时阶段不刷金币')
  const coin = await alpha.box.waitFor('coin.spawned', () => true, 4_500)
  check(coin.row >= 0 && coin.row <= 4 && coin.col >= 0 && coin.col <= 4, '金币坐标在 5x5 内')
  const acks = await Promise.all([
    ...Array.from({ length: 50 }, () => claim(alpha.socket, coin.coinId)),
    ...Array.from({ length: 50 }, () => claim(beta.socket, coin.coinId)),
  ])
  check(acks.filter((ack) => ack.accepted).length === 1, '100 个并发请求只有 1 个抢到')
  const after = await connect(first.body.data.playerToken)
  const total = after.snap.players.reduce((sum, player) => sum + player.score, 0)
  check(total === 1, `房间总分只增加 1，实际 ${total}`)
  after.socket.disconnect()
  const nextCoin = await alpha.box.waitFor('coin.spawned', (payload) => payload.coinId !== coin.coinId, 5_000)
  const firstAck = claim(beta.socket, nextCoin.coinId, Date.now() + 120_000)
  await sleep(30)
  const secondAck = await claim(alpha.socket, nextCoin.coinId, 1)
  const winnerAck = await firstAck
  check(winnerAck.accepted === true && secondAck.accepted === false, '胜负按服务端到达顺序，不看 clickedAt')
  await sleep(Math.max(0, started.gameEndsAt - Date.now() + 1_200))
  const finished = await alpha.box.waitFor('game.finished', () => true, 5_000)
  check(Array.isArray(finished.leaderboard), '结束时广播排行榜')
  const late = await claim(alpha.socket, nextCoin.coinId)
  check(late.accepted === false && (late.reason === 'GAME_ENDED' || late.reason === 'GAME_NOT_PLAYING'), `结束后不能加分，实际 ${late.reason}`)
  const finalSnap = await connect(first.body.data.playerToken)
  check(finalSnap.snap.status === 'FINISHED', '结束后状态为 FINISHED')
  const scoreAfter = finalSnap.snap.players.reduce((sum, player) => sum + player.score, 0)
  check(scoreAfter === total + 1, `结束后分数不再变化，实际 ${scoreAfter}`)
  alpha.socket.disconnect()
  beta.socket.disconnect()
  finalSnap.socket.disconnect()
}

async function scenarioSlow() {
  const first = await join('SLOW01', 'Alice')
  const duplicate = await join('SLOW01', 'alice')
  check(duplicate.status === 409 && duplicate.body.error?.code === 'NICKNAME_TAKEN', '昵称大小写不敏感且冲突返回 NICKNAME_TAKEN')
  await join('SLOW01', 'Bob')
  await join('SLOW01', 'Cara')
  const fourth = await join('SLOW01', 'Dan')
  check(fourth.body.data.snapshot.status === 'PREPARING' && fourth.body.data.snapshot.playerCount === 4, '4 人房间继续准备')
  const watcher = await connect(first.body.data.playerToken)
  await sleep(5_000)
  const mark = watcher.box.events.length
  watcher.socket.emit('room.resume', { playerToken: first.body.data.playerToken })
  const midway = await watcher.box.waitFor('room.snapshot', () => true, 5_000, mark)
  check(midway.status === 'PREPARING', '未到 30 秒时仍是 PREPARING')
  await sleep(Math.max(0, first.body.data.snapshot.deadlineAt - Date.now() + 800))
  const countdown = await watcher.box.waitFor('game.countdown', (payload) => payload.phase === 'COUNTDOWN', 5_000)
  check(countdown.deadlineAt - Date.now() < 4_000, '30 秒结束后进入 3 秒倒计时')
  const lateJoin = await join('SLOW01', 'Eve')
  check(lateJoin.status === 409 && lateJoin.body.error?.code === 'ROOM_STARTED', '倒计时开始后未满员房间拒绝加入')
  await sleep(Math.max(0, countdown.deadlineAt - Date.now() + 800))
  const started = await watcher.box.waitFor('game.started', () => true, 5_000)
  check(started.gameEndsAt - started.startedAt === 60_000, '4 人房间开局时长 60 秒')
  const coin = await watcher.box.waitFor('coin.spawned', () => true, 4_500)
  check(Boolean(coin.coinId), '4 人房间开始刷金币')
  watcher.socket.disconnect()
}

async function scenarioSolo() {
  const first = await join('SOLO01', '独行')
  const watcher = await connect(first.body.data.playerToken)
  await sleep(Math.max(0, first.body.data.snapshot.deadlineAt - Date.now() + 800))
  const countdown = await watcher.box.waitFor('game.countdown', (payload) => payload.phase === 'COUNTDOWN', 5_000)
  check(countdown.phase === 'COUNTDOWN', '只剩 1 人也进入 3 秒倒计时')
  await sleep(Math.max(0, countdown.deadlineAt - Date.now() + 800))
  await watcher.box.waitFor('game.started', () => true, 5_000)
  const coin = await watcher.box.waitFor('coin.spawned', () => true, 4_500)
  check(Boolean(coin.coinId), '单人房间开始刷金币')
  watcher.socket.disconnect()
}

async function main() {
  assertClient()
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 })
  await cleanup(redis)
  const health = await waitReady()
  check(health.body.success === true && health.body.error == null && typeof health.body.serverTime === 'number', '健康检查返回统一响应')
  const badCode = await join('abc', '玩家')
  const blank = await join('ABCD12', '   ')
  const longName = await join('ABCD12', '一二三四五六七八九十一二三四五六七八九十一')
  check(badCode.status === 400 && badCode.body.error?.code === 'INVALID_ROOM_CODE', '非法房间号返回 400')
  check(blank.status === 400 && blank.body.error?.code === 'INVALID_NICKNAME', '空白昵称返回 400')
  check(longName.status === 400 && longName.body.error?.code === 'INVALID_NICKNAME', '超长昵称返回 400')
  check(!(await redis.exists('roomcode:abc')), '非法房间号不会创建房间')
  check(!(await redis.exists('roomcode:ABCD12')), '参数错误不会留下半成品房间')
  const crowd = await Promise.all(Array.from({ length: 10 }, (_, index) => join('CAPA01', `并发${index}`)))
  const wins = crowd.filter((item) => item.status === 200)
  const fulls = crowd.filter((item) => item.status === 409 && item.body.error?.code === 'ROOM_FULL')
  check(wins.length === 5 && fulls.length === 5, `并发加入成功 ${wins.length} 人，拒绝 ${fulls.length} 人`)
  const results = await Promise.allSettled([scenarioFast(), scenarioSlow(), scenarioSolo()])
  for (const result of results) {
    if (result.status === 'rejected') {
      failures.push(result.reason?.stack || result.reason?.message || String(result.reason))
      console.error(result.reason)
    }
  }
  if (LOG_FILE && fs.existsSync(LOG_FILE)) {
    const log = fs.readFileSync(LOG_FILE, 'utf8')
    check(log.includes('[IN ] http POST /api/rooms/join'), '加入请求有进入日志')
    check(/\[OUT\] http POST \/api\/rooms\/join.*status=409 code=ROOM_FULL/.test(log), '满员拒绝日志能对上状态码和错误码')
    check(log.includes('from=WAITING to=PREPARING'), '准备阶段有状态前后日志')
    check(log.includes('from=PREPARING to=COUNTDOWN reason=ROOM_FULL'), '满员打断有状态日志')
    check(log.includes('acquired=true') && log.includes('acquired=false'), '抢到和没抢到都有日志')
    const leaked = wins.some((item) => log.includes(item.body.data.playerToken))
    check(!leaked, '日志没有打印完整 playerToken')
  } else {
    failures.push('没有找到服务日志文件')
  }
  await redis.quit()
  if (failures.length) {
    console.error(`冒烟失败 ${failures.length} 项`)
    process.exit(1)
  }
  console.log('冒烟通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

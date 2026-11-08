export function createClientState() {
  return {
    screen: 'lobby',
    selfId: null,
    roomCode: '',
    roomId: null,
    clockOffset: 0,
    offsetSamples: [],
    eventSeq: -1,
    status: null,
    deadlineAt: 0,
    gameStartedAt: null,
    gameEndsAt: null,
    playerCount: 0,
    players: [],
    activeCoin: null,
    fx: null,
    pendingCoinId: null,
    lastClaimAt: {},
  }
}

function playerOf(raw) {
  return {
    playerId: raw.playerId,
    nickname: raw.nickname,
    score: Number(raw.score) || 0,
    connectionState: raw.connectionState || 'ONLINE',
    joinedAt: Number(raw.joinedAt) || 0,
  }
}

function coinOf(raw) {
  if (!raw?.coinId) return null
  return {
    coinId: raw.coinId,
    row: Number(raw.row),
    col: Number(raw.col),
    status: raw.status || 'ACTIVE',
    spawnedAt: Number(raw.spawnedAt) || 0,
    expiresAt: Number(raw.expiresAt) || 0,
  }
}

function noteOffset(state, serverTime, now) {
  if (!serverTime) return { clockOffset: state.clockOffset, offsetSamples: state.offsetSamples || [] }
  const offsetSamples = [...(state.offsetSamples || []), serverTime - now].slice(-5)
  const sorted = [...offsetSamples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const trusted = offsetSamples.filter((sample) => sample <= median + 1500)
  return { clockOffset: Math.max(...(trusted.length ? trusted : offsetSamples)), offsetSamples }
}

function scoresOf(players) {
  return players.map((player) => `${player.playerId}:${player.score}`).join(',')
}

export function displaySeconds(state, now) {
  const remain = state.deadlineAt - (now + state.clockOffset)
  if (remain <= 0) return 0
  return Math.ceil(remain / 1000)
}

export function visibleCoin(state, now) {
  if (state.status !== 'PLAYING' || !state.activeCoin) return null
  // 画面到达晚于 spawnedAt。这里用服务端 expiresAt 判断，过期金币不作为点击目标。
  if (state.activeCoin.expiresAt && now + state.clockOffset >= state.activeCoin.expiresAt) return null
  if (state.fx?.coinId === state.activeCoin.coinId) return null
  return state.activeCoin
}

function applySnapshot(state, snapshot, logs, force = false) {
  if (!force && snapshot.eventSeq != null && Number(snapshot.eventSeq) < state.eventSeq) {
    logs.push(`[STATE] page from=snapshot to=ignored reason=STALE_SEQ eventSeq=${snapshot.eventSeq}`)
    return state
  }
  const activeCoin = coinOf(snapshot.activeCoin)
  let fx = state.fx
  if (fx && (!activeCoin || activeCoin.coinId !== fx.coinId) && fx.mode !== 'break') fx = null
  return {
    ...state,
    status: snapshot.status,
    deadlineAt: Number(snapshot.deadlineAt) || 0,
    gameStartedAt: snapshot.gameStartedAt ?? null,
    gameEndsAt: snapshot.gameEndsAt ?? null,
    playerCount: Number(snapshot.playerCount ?? snapshot.players?.length ?? 0),
    players: (snapshot.players || []).map(playerOf),
    activeCoin,
    eventSeq: Number(snapshot.eventSeq ?? state.eventSeq),
    fx,
  }
}

function withScore(players, playerId, score) {
  return players.map((player) => (player.playerId === playerId ? { ...player, score: Number(score) } : player))
}

export function reduce(state, action) {
  const logs = []
  const now = action.now ?? Date.now()
  if (action.type === 'join') {
    const snapshot = action.data.snapshot
    logs.push(`[STATE] page from=lobby to=room reason=JOIN_SUCCESS status=${snapshot.status}`)
    return {
      emit: false,
      logs,
      state: {
        ...applySnapshot(state, snapshot, logs),
        screen: 'room',
        selfId: action.data.playerId,
        roomCode: action.roomCode,
        roomId: action.data.roomId,
        ...noteOffset(state, action.serverTime, now),
      },
    }
  }
  if (action.type === 'snapshot') {
    if (action.payload.eventSeq != null && Number(action.payload.eventSeq) < state.eventSeq && !(state.needsSync && Number(action.payload.eventSeq) >= Number(state.syncFrom ?? -1))) {
      logs.push(`[STATE] page from=snapshot to=ignored reason=STALE_SEQ eventSeq=${action.payload.eventSeq}`)
      return { state, logs, emit: false }
    }
    const repairing = Boolean(state.needsSync && Number(action.payload.eventSeq) >= Number(state.syncFrom ?? -1))
    const next = applySnapshot(state, action.payload, logs, repairing)
    if (state.selfId && Array.isArray(action.payload.players) && !next.players.some((player) => player.playerId === state.selfId)) {
      logs.push(`[STATE] page from=${state.screen} to=lobby reason=SELF_MISSING`)
      return {
        state: { ...createClientState(), clockOffset: state.clockOffset, offsetSamples: state.offsetSamples },
        logs,
        emit: false,
        selfLeft: true,
      }
    }
    if (action.payload.serverTime) {
      const timed = noteOffset(next, action.payload.serverTime, now)
      next.clockOffset = timed.clockOffset
      next.offsetSamples = timed.offsetSamples
    }
    if (action.payload.roomId) next.roomId = action.payload.roomId
    next.needsSync = false
    if (state.needsSync) next.eventSeq = Number(action.payload.eventSeq ?? next.eventSeq)
    logs.push(`[STATE] page from=${state.status} to=${next.status} reason=SNAPSHOT eventSeq=${next.eventSeq}`)
    return { state: next, logs, emit: false }
  }
  if (action.type === 'fx-clear') {
    if (state.fx?.coinId !== action.coinId || state.pendingCoinId) return { state, logs, emit: false }
    logs.push(`[STATE] fx coinId=${action.coinId} from=${state.fx.mode} to=none reason=ANIMATION_DONE`)
    return { state: { ...state, fx: null }, logs, emit: false }
  }
  if (action.type === 'leave-view') {
    logs.push(`[STATE] page from=${state.screen} to=lobby reason=${action.reason || 'LEAVE_VIEW'}`)
    return { state: { ...createClientState(), clockOffset: state.clockOffset }, logs, emit: false }
  }
  if (action.type === 'claim-click') {
    const coin = visibleCoin(state, now)
    if (!coin || coin.coinId !== action.coinId) return { state, logs, emit: false }
    if (state.pendingCoinId === coin.coinId) return { state, logs, emit: false }
    const last = state.lastClaimAt[coin.coinId] || 0
    if (now - last < 1000) return { state, logs, emit: false }
    const before = scoresOf(state.players)
    const next = {
      ...state,
      pendingCoinId: coin.coinId,
      pendingRequestId: action.requestId || null,
      pendingSince: now,
      lastClaimAt: { ...state.lastClaimAt, [coin.coinId]: now },
      fx: { coinId: coin.coinId, row: coin.row, col: coin.col, mode: 'break' },
    }
    logs.push(`[STATE] coin coinId=${coin.coinId} from=idle to=pending reason=CLICK score=${before}->${scoresOf(next.players)}`)
    logs.push(`[STATE] fx coinId=${coin.coinId} from=none to=break reason=OPTIMISTIC`)
    return { state: next, logs, emit: true }
  }
  if (action.type === 'claim-ack') {
    const ack = action.ack || {}
    if (ack.requestId && state.pendingRequestId && ack.requestId !== state.pendingRequestId) {
      return { state, logs, emit: false }
    }
    const coinId = state.pendingCoinId
    const next = { ...state, pendingCoinId: null, pendingRequestId: null, pendingSince: 0 }
    if (ack.accepted) {
      logs.push(`[STATE] coin coinId=${coinId} from=pending to=confirmed reason=CLAIM_ACCEPTED score=${scoresOf(state.players)}`)
      return { state: next, logs, emit: false }
    }
    const stillThere = state.activeCoin?.coinId === coinId
    if (ack.reason === 'ALREADY_CLAIMED' || !stillThere) {
      next.fx = state.fx ? { ...state.fx, mode: 'gone' } : null
      logs.push(`[STATE] fx coinId=${coinId} from=break to=gone reason=${ack.reason || 'COIN_GONE'}`)
    } else {
      next.fx = null
      logs.push(`[STATE] coin coinId=${coinId} from=pending to=idle reason=ROLLBACK`)
      logs.push(`[STATE] fx coinId=${coinId} from=break to=none reason=ROLLBACK`)
    }
    return { state: next, logs, emit: false }
  }
  if (action.type === 'claim-timeout') {
    if (state.pendingCoinId !== action.coinId) return { state, logs, emit: false }
    const stillThere = state.activeCoin?.coinId === action.coinId
    logs.push(`[STATE] coin coinId=${action.coinId} from=pending to=idle reason=ACK_TIMEOUT`)
    return {
      state: {
        ...state,
        pendingCoinId: null,
        pendingRequestId: null,
        pendingSince: 0,
        fx: stillThere ? null : state.fx,
      },
      logs,
      emit: false,
    }
  }
  if (action.type === 'clock') {
    return { state: { ...state, ...noteOffset(state, action.serverTime, now) }, logs, emit: false }
  }
  if (action.type !== 'event') return { state, logs, emit: false }

  const payload = action.payload || {}
  if (payload.eventSeq == null) return { state, logs, emit: false }
  if (payload.eventSeq <= state.eventSeq) return { state, logs, emit: false }
  let sync = false
  const syncFrom = state.eventSeq
  if (state.eventSeq >= 0 && payload.eventSeq > state.eventSeq + 1) {
    logs.push(`[WARN] eventSeq jump from=${state.eventSeq} to=${payload.eventSeq}`)
    sync = true
  }
  const timed = noteOffset(state, payload.serverTime, now)
  const next = {
    ...state,
    eventSeq: payload.eventSeq,
    clockOffset: timed.clockOffset,
    offsetSamples: timed.offsetSamples,
    needsSync: sync || state.needsSync,
    syncFrom: sync ? state.eventSeq : state.syncFrom,
  }
  const serverNow = now + state.clockOffset
  if (action.name === 'player.joined' && payload.player) {
    const player = playerOf(payload.player)
    if (!next.players.some((item) => item.playerId === player.playerId)) {
      next.players = [...next.players, player]
    }
    next.playerCount = payload.playerCount
    logs.push(`[STATE] player playerId=${player.playerId} from=ABSENT to=ONLINE reason=PLAYER_JOINED playerCount=${payload.playerCount}`)
  } else if (action.name === 'player.left') {
    next.players = next.players.filter((player) => player.playerId !== payload.playerId)
    next.playerCount = Number(payload.playerCount) || 0
    logs.push(`[STATE] player playerId=${payload.playerId} from=ONLINE to=OFFLINE reason=${payload.reason || 'LEFT'} playerCount=${payload.playerCount}`)
    if (payload.playerId === state.selfId) {
      return {
        state: { ...createClientState(), clockOffset: next.clockOffset, offsetSamples: next.offsetSamples },
        logs,
        emit: false,
        selfLeft: true,
      }
    }
  } else if (action.name === 'game.countdown') {
    logs.push(`[STATE] page from=${state.status} to=${payload.phase} reason=COUNTDOWN deadlineAt=${payload.deadlineAt}`)
    next.status = payload.phase
    next.deadlineAt = Number(payload.deadlineAt) || 0
  } else if (action.name === 'game.started') {
    logs.push(`[STATE] page from=${state.status} to=PLAYING reason=GAME_STARTED gameEndsAt=${payload.gameEndsAt}`)
    next.status = 'PLAYING'
    next.gameStartedAt = payload.startedAt
    next.gameEndsAt = payload.gameEndsAt
    next.deadlineAt = Number(payload.gameEndsAt) || 0
    next.activeCoin = null
  } else if (action.name === 'coin.spawned') {
    if (payload.expiresAt && serverNow >= payload.expiresAt) {
      next.activeCoin = null
      logs.push(`[STATE] coin coinId=${payload.coinId} from=spawn to=ignored reason=EXPIRED_ON_ARRIVAL`)
    } else {
      next.activeCoin = coinOf(payload)
      if (next.fx && next.fx.coinId !== payload.coinId && next.fx.mode !== 'break') next.fx = null
      logs.push(`[STATE] coin coinId=${payload.coinId} from=none to=active reason=SPAWN`)
    }
  } else if (action.name === 'coin.removed') {
    if (next.activeCoin?.coinId === payload.coinId) next.activeCoin = null
    logs.push(`[STATE] coin coinId=${payload.coinId} from=active to=removed reason=${payload.reason || 'REMOVED'}`)
  } else if (action.name === 'coin.claimed') {
    if (next.activeCoin?.coinId === payload.coinId) next.activeCoin = null
    next.players = withScore(next.players, payload.winnerId, payload.score)
    logs.push(`[STATE] coin coinId=${payload.coinId} from=active to=claimed reason=COIN_CLAIMED winnerId=${payload.winnerId}`)
  } else if (action.name === 'score.updated') {
    next.players = withScore(next.players, payload.playerId, payload.score)
    logs.push(`[STATE] player playerId=${payload.playerId} from=score to=score:${payload.score} reason=SCORE_UPDATED rank=${payload.rank}`)
  } else if (action.name === 'game.finished') {
    logs.push(`[STATE] page from=${state.status} to=FINISHED reason=GAME_FINISHED`)
    next.status = 'FINISHED'
    next.activeCoin = null
    next.pendingCoinId = null
    next.deadlineAt = Number(payload.finishedAt) || next.deadlineAt
    if (Array.isArray(payload.leaderboard)) {
      next.players = next.players.map((player) => {
        const row = payload.leaderboard.find((item) => item.playerId === player.playerId)
        return row ? { ...player, score: Number(row.score) || 0 } : player
      })
    }
  }
  return { state: next, logs, emit: false, sync, syncFrom }
}

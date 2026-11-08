import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { createClientState, displaySeconds, reduce, visibleCoin } from './gameState.js'
import { logClient } from './logger.js'

const JOIN_ERRORS = {
  INVALID_ROOM_CODE: '房间号须为 6 位大写字母或数字',
  INVALID_NICKNAME: '昵称须为 1 到 20 个字符',
  ROOM_FULL: '房间已满，最多 5 人',
  NICKNAME_TAKEN: '该昵称已在房间中',
  ROOM_STARTED: '对局已开始，无法加入',
  ROOM_CLOSED: '房间已关闭',
}

const SERVER_EVENTS = [
  'player.joined',
  'game.countdown',
  'game.started',
  'coin.spawned',
  'coin.removed',
  'coin.claimed',
  'score.updated',
  'game.finished',
]

const PHASE_LABEL = {
  PREPARING: '准备倒计时',
  COUNTDOWN: '开局倒计时',
  PLAYING: '剩余时间',
  FINISHED: '对局结束',
  CLOSED: '房间已关闭',
}

export default function App() {
  const [state, setState] = useState(createClientState)
  const [token, setToken] = useState('')
  const [roomCode, setRoomCode] = useState('')
  const [nickname, setNickname] = useState('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const stateRef = useRef(state)
  const socketRef = useRef(null)

  function dispatch(action) {
    const result = reduce(stateRef.current, action)
    result.logs.forEach(logClient)
    stateRef.current = result.state
    setState(result.state)
    return result
  }

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!token) return undefined
    const socket = io(window.location.origin, { path: '/ws' })
    socketRef.current = socket
    socket.on('connect', () => {
      socket.emit('room.resume', { playerToken: token })
    })
    socket.on('ping', (payload) => {
      socket.emit('pong', { nonce: payload?.nonce })
      if (payload?.serverTime) dispatch({ type: 'clock', serverTime: payload.serverTime, now: Date.now() })
      const current = stateRef.current
      if (payload?.eventSeq != null && current.eventSeq >= 0 && Number(payload.eventSeq) > current.eventSeq) {
        socket.emit('room.sync', { lastEventSeq: current.eventSeq })
      }
    })
    socket.on('room.snapshot', (payload) => {
      const result = dispatch({ type: 'snapshot', payload, now: Date.now() })
      if (result.selfLeft) setToken('')
    })
    for (const name of SERVER_EVENTS) {
      socket.on(name, (payload) => {
        const result = dispatch({ type: 'event', name, payload, now: Date.now() })
        if (result.sync) socket.emit('room.sync', { lastEventSeq: result.syncFrom })
      })
    }
    socket.on('player.left', (payload) => {
      const result = dispatch({ type: 'event', name: 'player.left', payload, now: Date.now() })
      if (result.selfLeft) setToken('')
      if (result.sync) socket.emit('room.sync', { lastEventSeq: result.syncFrom })
    })
    socket.on('room.error', (payload) => {
      logClient(`[STATE] page room.error code=${payload?.code || 'UNKNOWN'}`)
      if (payload?.code === 'UNAUTHORIZED') {
        setToken('')
        setFormError('登录已失效，请重新加入')
        dispatch({ type: 'leave-view', reason: 'UNAUTHORIZED' })
      }
    })
    return () => {
      socket.disconnect()
      if (socketRef.current === socket) socketRef.current = null
    }
  }, [token])

  useEffect(() => {
    if (state.fx?.mode !== 'break' || state.pendingCoinId) return undefined
    const coinId = state.fx.coinId
    const timer = setTimeout(() => dispatch({ type: 'fx-clear', coinId }), 480)
    return () => clearTimeout(timer)
  }, [state.fx, state.pendingCoinId])

  async function onJoin(event) {
    event.preventDefault()
    setFormError('')
    setSubmitting(true)
    const code = roomCode.trim().toUpperCase()
    const name = nickname.trim()
    try {
      const response = await fetch('/api/rooms/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode: code, nickname: name }),
      })
      const body = await response.json()
      if (!body.success) {
        setFormError(JOIN_ERRORS[body.error?.code] || body.error?.code || '加入失败')
        return
      }
      setToken(body.data.playerToken)
      dispatch({
        type: 'join',
        data: body.data,
        roomCode: code,
        serverTime: body.serverTime,
        now: Date.now(),
      })
    } catch {
      setFormError('无法连接服务器')
    } finally {
      setSubmitting(false)
    }
  }

  async function onLeave() {
    const current = stateRef.current
    if (!token || !current.roomId) return
    try {
      await fetch(`/api/rooms/${current.roomId}/leave`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {
      logClient('[STATE] page leave request failed')
    }
    setToken('')
    dispatch({ type: 'leave-view', reason: 'LEAVE' })
  }

  function onCell(row, col) {
    const coin = visibleCoin(stateRef.current, Date.now())
    if (!coin || coin.row !== row || coin.col !== col) return
    const clickedAt = Date.now()
    const requestId = crypto.randomUUID()
    const result = dispatch({ type: 'claim-click', coinId: coin.coinId, requestId, now: clickedAt })
    if (!result.emit || !socketRef.current) {
      if (result.emit) {
        dispatch({ type: 'claim-ack', ack: { accepted: false, reason: 'INVALID_COIN', requestId }, now: Date.now() })
      }
      return
    }
    const timer = setTimeout(() => {
      dispatch({ type: 'claim-timeout', coinId: coin.coinId, now: Date.now() })
    }, 3000)
    socketRef.current.emit('coin.claim', {
      coinId: coin.coinId,
      requestId,
      clickedAt,
    }, (ack) => {
      clearTimeout(timer)
      dispatch({ type: 'claim-ack', ack, now: Date.now() })
    })
  }

  if (state.screen === 'lobby') {
    return (
      <main className="lobby">
        <form className="ticket" data-testid="lobby-form" onSubmit={onJoin}>
          <h1>多人打地鼠</h1>
          <p>输入房间号和昵称。加入成功后才会进入抢夺区。</p>
          <label htmlFor="roomCode">房间号</label>
          <input
            id="roomCode"
            data-testid="room-code"
            maxLength={6}
            autoCapitalize="characters"
            value={roomCode}
            onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
          />
          <label htmlFor="nickname">昵称</label>
          <input
            id="nickname"
            data-testid="nickname"
            maxLength={20}
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
          />
          <button className="submit" data-testid="join-submit" type="submit" disabled={submitting}>
            {submitting ? '加入中' : '加入房间'}
          </button>
          {formError ? <div className="error" data-testid="join-error">{formError}</div> : null}
        </form>
      </main>
    )
  }

  const seconds = displaySeconds(state, now)
  const coin = visibleCoin(state, now)
  const ranked = [...state.players].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)

  return (
    <main className="table" data-testid="game-view">
      <header className="topbar">
        <div>
          <p className="eyebrow">房间 {state.roomCode} · {state.playerCount}/5</p>
          <h2>{PHASE_LABEL[state.status] || '等待服务端'}</h2>
        </div>
        <p className="countdown" data-testid="countdown">{state.status === 'FINISHED' ? '结束' : `${seconds}s`}</p>
        <button className="leave" data-testid="leave-room" type="button" onClick={onLeave}>退出</button>
      </header>
      <section className="play">
        <aside className="board">
          <h3>积分榜</h3>
          <ol data-testid="scoreboard">
            {ranked.map((player, index) => (
              <li
                key={player.playerId}
                className={player.playerId === state.selfId ? 'me' : ''}
                data-testid={`player-${player.playerId}`}
                data-score={player.score}
              >
                <span>{index + 1}</span>
                <span>{player.nickname}</span>
                <strong>{player.score}</strong>
              </li>
            ))}
          </ol>
        </aside>
        <section className="arena">
          <div className="grid" data-testid="grid">
            {Array.from({ length: 25 }, (_, index) => {
              const row = Math.floor(index / 5)
              const col = index % 5
              const fxMode = (state.fx?.mode === 'break' || state.fx?.mode === 'gone') && state.fx.row === row && state.fx.col === col
                ? state.fx.mode
                : ''
              const coinHere = coin && coin.row === row && coin.col === col
              return (
                <button
                  key={`${row}-${col}`}
                  type="button"
                  className="cell"
                  data-testid={`cell-${row}-${col}`}
                  onClick={() => onCell(row, col)}
                >
                  {fxMode ? <span className={`coin ${fxMode}`} data-testid="coin-fx" /> : null}
                  {coinHere ? <span className="coin" data-testid="coin" /> : null}
                </button>
              )
            })}
          </div>
          {state.status === 'COUNTDOWN' ? <div className="overlay" data-testid="countdown-overlay">{seconds || 1}</div> : null}
          {state.status === 'FINISHED' ? <div className="overlay" data-testid="finished-overlay">结束</div> : null}
          {state.status === 'PREPARING' ? <p className="hint">等待其他玩家，满 5 人会立刻进入 3、2、1</p> : null}
        </section>
      </section>
    </main>
  )
}

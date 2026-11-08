import { logger } from './logger.js'

let pool = null
let schemaReady = false

async function getPool() {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) return null
  const pg = await import('pg')
  const Pool = pg.default?.Pool || pg.Pool
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 1000,
    max: 2,
  })
  pool.on('error', (error) => logger.error(`postgres pool message=${error.message}`))
  return pool
}

export function archiveMatch({ roomId, roomCode, status, finishedAt, leaderboard }) {
  setImmediate(() => {
    saveMatch({ roomId, roomCode, status, finishedAt, leaderboard }).catch((error) => {
      logger.error(`archive failed roomId=${roomId} reason=${error.message}`)
    })
  })
}

async function saveMatch({ roomId, roomCode, status, finishedAt, leaderboard }) {
  const db = await getPool()
  if (!db) {
    logger.error(`archive failed roomId=${roomId} reason=POSTGRES_UNAVAILABLE`)
    return
  }
  if (!schemaReady) {
    await db.query(`CREATE TABLE IF NOT EXISTS finished_matches (
      room_id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL,
      status TEXT NOT NULL,
      finished_at BIGINT NOT NULL,
      leaderboard JSONB NOT NULL,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    schemaReady = true
  }
  await db.query(
    `INSERT INTO finished_matches (room_id, room_code, status, finished_at, leaderboard)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (room_id) DO UPDATE SET
       status = EXCLUDED.status,
       finished_at = EXCLUDED.finished_at,
       leaderboard = EXCLUDED.leaderboard,
       saved_at = NOW()
     WHERE jsonb_array_length(EXCLUDED.leaderboard) >= jsonb_array_length(finished_matches.leaderboard)`,
    [roomId, roomCode || '', status, Number(finishedAt) || Date.now(), JSON.stringify(leaderboard || [])],
  )
  logger.info(`archive saved roomId=${roomId} status=${status}`)
}

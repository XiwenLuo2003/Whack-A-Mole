export const MAX_PLAYERS = 5
export const PREPARE_MS = 30_000
export const COUNTDOWN_MS = 3_000
export const PLAYING_MS = 60_000
export const CLAIM_TTL_SEC = 180
export const GRACE_MS = 10_000
export const PRESENCE_TTL_SEC = 30
export const HEARTBEAT_MS = 10_000
export const HEARTBEAT_TIMEOUT_MS = 30_000
export const REQUEST_TTL_SEC = 120
export const CLAIM_RATE_LIMIT = 60
export const TICK_MS = 100
export const LEASE_MS = 3_000
export const CLOSED_TTL_SEC = 600
export const COIN_INTERVAL_MIN_MS = 1_000
export const COIN_INTERVAL_MAX_MS = 3_000

export function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1))
}

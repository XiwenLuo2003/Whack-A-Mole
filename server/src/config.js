export const config = {
  port: Number(process.env.PORT || 3000),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  tokenSecret: process.env.TOKEN_SECRET || 'dev-only-token-secret-change-me',
  tokenTtlMs: 2 * 60 * 60 * 1000,
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
}

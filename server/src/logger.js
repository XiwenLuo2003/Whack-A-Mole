import fs from 'fs'
import { config } from './config.js'

const RANK = { debug: 10, info: 20, warn: 30, error: 40 }
const current = RANK[config.logLevel] ?? RANK.debug

function write(level, message) {
  if (RANK[level] < current) return
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  if (process.env.LOG_FILE) fs.appendFileSync(process.env.LOG_FILE, `${line}\n`)
}

export const logger = {
  debug: (message) => write('debug', message),
  info: (message) => write('info', message),
  warn: (message) => write('warn', message),
  error: (message) => write('error', message),
}

export function maskSecret(value) {
  if (!value) return ''
  const text = String(value)
  if (text.length <= 6) return '******'
  return `***${text.slice(-6)}`
}

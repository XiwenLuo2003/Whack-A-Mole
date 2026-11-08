export function logClient(line) {
  if (line.startsWith('[WARN]')) console.warn(line)
  else console.debug(line)
}

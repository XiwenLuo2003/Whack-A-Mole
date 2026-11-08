export function send(res, status, { success, data = null, error = null }) {
  res.locals.errorCode = error?.code || (success ? 'OK' : 'ERROR')
  res.status(status).json({
    success,
    data,
    error,
    serverTime: Date.now(),
  })
}

export const JOIN_ERROR_TEXT = {
  INVALID_ROOM_CODE: '房间号须为 6 位大写字母或数字',
  INVALID_NICKNAME: '昵称须为 1 到 20 个字符',
  ROOM_FULL: '房间已满',
  NICKNAME_TAKEN: '昵称已被占用',
  ROOM_STARTED: '对局已开始，无法加入',
  ROOM_CLOSED: '房间已关闭',
}

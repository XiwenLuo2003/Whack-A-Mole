# 多人同屏打地鼠——全局规则

本文档约束前后端实现时必须遵守的全局规则。架构细节以 `DESIGN.md` 为准；本文件只规定“必须怎么做、禁止怎么做”。

## 1. 日志与可调试性

所有关键路径都必须能通过日志复盘，不能只靠打断点。

### 1.1 请求进入与请求发出

- HTTP 请求进入时打印：方法、路径、`requestId`、`roomId`、`playerId`、关键入参。
- HTTP 响应发出时打印：`requestId`、状态码、成功/失败、错误码、耗时。
- WebSocket 事件进入时打印：事件名、`requestId`、`roomId`、`playerId`、关键载荷。
- WebSocket 事件发出/广播时打印：事件名、`eventSeq`、目标房间、关键字段。
- 日志中禁止打印 `playerToken`、签名密钥等敏感信息；需要关联时只打印后 6 位。

建议格式：

```text
[IN ] http POST /api/rooms/join requestId=... roomCode=ABCD12 nickname=玩家A
[OUT] http POST /api/rooms/join requestId=... status=409 code=ROOM_FULL cost=12ms
[IN ] ws   coin.claim requestId=... roomId=... playerId=... coinId=...
[OUT] ws   coin.claimed eventSeq=18 roomId=... coinId=... winnerId=...
```

### 1.2 状态变化前后

房间、玩家、金币的状态变更必须成对打印“变更前”和“变更后”，并写明触发原因。

必须记录的字段：

- `from` / `to`
- `reason`
- `roomId`
- 相关 `playerId` / `coinId`
- 变更前后的关键快照：`playerCount`、`deadlineAt`、`activeCoin`、玩家 `score`

示例：

```text
[STATE] room roomId=... from=PREPARING to=COUNTDOWN reason=ROOM_FULL playerCount=5 deadlineAt=...
[STATE] coin roomId=... coinId=... from=ACTIVE to=CLAIMED reason=CLAIM_SUCCESS winnerId=... score=3
[STATE] player roomId=... playerId=... from=ONLINE to=RECONNECTING reason=WS_DISCONNECT lastSeenAt=...
```

规则：

1. 状态还没写入存储前，先读出旧值并记录。
2. 写入成功后再记录新值；写入失败必须记录失败原因，不能假装状态已变化。
3. 比较并设置（CAS / Lua）失败时也要打日志：期望旧状态、实际旧状态、目标新状态。
4. 前端本地状态机同样遵守：页面切换、金币锁定/解锁、乐观动画回滚都要打前后状态。

### 1.3 定时器与锁

- 游戏循环每次调度打印：房间 ID、当前状态、下次计划时间、本次动作（生成金币 / 切阶段 / 结束）。
- 抢占锁成功或失败都打印：`coinId`、`playerId`、是否抢到、当前获胜者。
- 心跳超时、宽限期开始/结束、僵尸清理都打印清理对象和原因。

### 1.4 日志级别

| 级别 | 使用场景 |
|---|---|
| `debug` | 请求进出、状态前后、广播内容、心跳 |
| `info` | 房间创建、玩家加入/退出、阶段切换、对局开始/结束 |
| `warn` | 房间已满被拒、重复点击、抢占失败、序号跳跃、重连 |
| `error` | 未预期异常、Lua 执行失败、状态机非法跳转、循环丢失 |

开发环境默认输出 `debug`；生产环境默认 `info`，但抢金币和状态跳转仍建议保留。

## 2. 状态机规则

- 状态只能按 `WAITING -> PREPARING -> COUNTDOWN -> PLAYING -> FINISHED -> CLOSED` 前进，禁止回跳。
- 状态转换只能由服务端执行；前端只展示服务端下发的状态和 `deadlineAt`。
- 任何阶段切换都必须满足前置条件，并用原子操作完成“校验 + 写入”。
- 首个玩家加入才启动 30 秒准备；同一房间只能启动一次准备计时。
- 准备阶段满 5 人时立即取消剩余 30 秒，转入 3 秒倒计时。
- 30 秒结束仍未满员时，按当前人数进入 3 秒倒计时，即使只剩 1 人也开局。
- `COUNTDOWN` 开始后禁止新玩家加入，也不再补位。
- 倒计时以服务端绝对时间戳为准，禁止多个客户端各自用 `setTimeout` 决定是否开局。
- 进入 `PLAYING` 后写入 `gameEndsAt`；到达该时间必须先切到 `FINISHED`，再停止生成金币并拒绝加分。

## 3. 房间与玩家生命周期

- 每个房间最多 5 人。加入必须原子判断人数，禁止“先查人数再写入”。
- 第 6 人加入必须明确拒绝，错误码固定为 `ROOM_FULL`。
- 房间已进入 `COUNTDOWN` / `PLAYING` / `FINISHED` / `CLOSED` 时拒绝加入，错误码为 `ROOM_STARTED` 或 `ROOM_CLOSED`。
- 同一房间昵称大小写不敏感唯一，冲突返回 `NICKNAME_TAKEN`。
- 加入成功后必须向房内广播 `player.joined`，并带上最新人数。
- 主动退出、心跳超时、宽限期结束都必须走同一套退出逻辑，并广播 `player.left`。
- WebSocket 意外断开后进入 10 秒重连宽限期；宽限期内可用同一 `playerToken` 恢复原 `playerId` 和积分。
- 宽限期结束才真正移除玩家。游戏中全员离开则提前关闭房间。
- 心跳 10 秒一次；连续 30 秒无响应视为僵尸连接，必须清理。

## 4. 金币与计分

- 每个房间同一时刻最多一枚有效金币。
- 每枚金币必须有全局唯一 `coinId`。后续所有点击、锁定、抢占、日志都以该 ID 为准，禁止只按格子坐标判定。
- 金币被点中后立刻消失；未点中而过期、被替换或对局结束时也必须广播移除。
- 同一金币绝对不能给两个人加分。抢占、校验、加分必须在同一原子操作内完成。
- 积分只能由服务端增加。前端可以播动画，但不能先改计分板。
- 胜负以服务端接收并完成原子脚本的顺序为准，忽略客户端 `clickedAt`。
- `requestId` 只用于幂等回执，不能代替 `coinId` 抢占锁。
- 游戏结束后到达的任何抢金币请求都必须拒绝，且不改分数。

## 5. 前端交互规则

- 房间大厅只收集房间号和昵称，成功后再进入准备/游戏视图。
- 主视图固定为：顶部 60 秒倒计时、左侧积分榜、中央 5x5 抢夺区。
- 玩家首次点击某枚金币后，立即把该 `coinId` 标为 `pending/locked`，在服务端回执到达前忽略后续点击。
- 前端必须做节流或状态锁定，禁止 1 秒内对同一金币连发多次 `coin.claim`。
- 乐观更新只作用于金币动画（碎裂、变灰、飞出），不作用于分数。
- 服务端判定成功：保留动画，等待 `score.updated` / `coin.claimed` 更新分数。
- 服务端判定失败：若金币仍有效则回滚展示；若已被他人抢走则保持消失。
- 发现 `eventSeq` 跳跃时立刻请求 `room.sync`，用服务端快照覆盖本地权威状态。
- 倒计时展示使用 `deadlineAt - (Date.now() + clockOffset)`，收到服务端时间后校准时钟偏移。
- 收到已过期金币（`serverNow >= expiresAt`）时不渲染，避免把延迟到达的旧金币当成新目标。

## 6. 请求与接口规则

- 所有 HTTP / WebSocket 业务响应都带 `serverTime`。
- 失败必须返回稳定错误码，不返回模糊文案了事。加入失败至少支持：`ROOM_FULL`、`ROOM_STARTED`、`NICKNAME_TAKEN`、`ROOM_CLOSED`。
- 抢金币失败至少支持：`INVALID_COIN`、`ALREADY_CLAIMED`、`GAME_NOT_PLAYING`、`GAME_ENDED`、`PLAYER_NOT_ACTIVE`。
- `leave` 接口必须幂等：玩家已离开时仍返回成功。
- 重复的 `coin.claim`（同一 `playerId + requestId`）返回首次结果，不重新抢占。
- 广播事件必须带 `roomId`、`eventSeq`、`serverTime`。
- 服务端限流是第二道防线；即使前端节流失效，也不能被连点打穿。

## 7. 时间与延迟

- 所有阶段时长以服务端时间为准：准备 30 秒、开局 3 秒、对局 60 秒。
- 禁止用客户端本地时钟决定开局、结束或金币是否有效。
- 必须承认网络延迟：前端看到金币的时间晚于服务端 `spawnedAt`。处理方式是下发绝对时间，而不是让客户端“谁先看到谁算”。
- 定时器只负责触发检查；是否切阶段、是否生成/回收金币，仍以 Redis 中的状态和截止时间为准。
- 进程重启后按 Redis 绝对时间恢复，不允许假定内存里的 `setTimeout` 还在。

## 8. 并发与数据一致性

- 禁止“读取 -> 应用内判断 -> 写回”这种非原子更新人数、状态或分数。
- 多实例部署时，加入房间、阶段切换、抢金币都必须可在 Redis Lua / 等价原子脚本中完成。
- 每个房间同一时刻只允许一个游戏循环所有者；租约丢失后才能被其他实例接管。
- 权威数据源是服务端实时状态（Redis），不是某个客户端内存，也不是某次广播是否送达。
- 广播失败不改正服状态；客户端通过快照补偿对齐。

## 9. 安全与边界

- 所有需登录态的 HTTP 和 WebSocket 请求都必须校验 `playerToken`，并核对 `roomId/playerId`。
- 昵称长度 1～20，房间号 6 位大写字母或数字，坐标只能是 0～4。
- 限制事件体大小和每玩家请求频率。
- 不信任客户端传入的分数、房间人数、当前状态、金币坐标或点击时间。
- 日志、接口文档和调试输出都不得泄露完整令牌。

## 10. 实现时的禁止项

- 禁止前端先加分再等服务端“纠正”。
- 禁止用格子坐标代替 `coinId`。
- 禁止房间满员后静默丢弃加入请求。
- 禁止准备倒计时和开局倒计时混用同一个本地 timer 而不更新 `deadlineAt`。
- 禁止在 `COUNTDOWN` 或 `PLAYING` 阶段继续拉人进房。
- 禁止游戏结束后仍生成金币或接受加分。
- 禁止只断开 WebSocket 却不处理僵尸玩家。
- 禁止状态变更、请求进出、抢占结果不打日志。

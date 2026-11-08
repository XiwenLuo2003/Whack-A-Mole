# 多人同屏打地鼠——阶段规划

本文档把 `README.md` 的题目要求，按 `DESIGN.md` 的架构、接口、字段和 `RULE.md` 的全局规则，拆成可顺序交付的任务。优先级表示实现顺序，不表示可选项：P0 不通过不得进入 P1；P1、P2 仍须完成，全部里程碑通过后才算需求完成。

状态枚举以数据字典为准：`WAITING`、`PREPARING`、`COUNTDOWN`、`PLAYING`、`FINISHED`、`CLOSED`。禁止使用文档示意图里的 `PREPARING_30S`、`COUNTDOWN_3S` 作为存储值。

## 1. 优先级

| 优先级 | 含义 | 不完成时的后果 |
|---|---|---|
| P0 | 主流程。没有它，服务无法启动，或无法走通进房、倒计时、刷金币、抢分、结算 | 架构冒烟失败 |
| P1 | 主功能完整性。保证加入/退出生命周期、断线、延迟和一致性在异常下仍然正确 | 主路径能玩，但房间人数、分数或画面会在异常下失真 |
| P2 | 边界、性能、多实例、持久化和体验 | 单房间主路径正确，但扩展和观测不足 |

依赖顺序：`M0 → M1 → M2 → M3` 是 P0 主链路。`M4`、`M5` 依赖 M3。`M6` 依赖 M5。后一阶段不得改变前一阶段已经验收的接口行为、错误码和状态流向。

## 2. 里程碑

| 里程碑 | 优先级 | 目标 | 退出标准 |
|---|---|---|---|
| M0 骨架可运行 | P0 | HTTP、WebSocket、Redis 能连通 | 健康检查通过；统一响应带 `serverTime`；日志骨架不打印完整令牌 |
| M1 进房闭环 | P0 | 大厅加入、5 人上限、快照和加入广播 | 第 6 人得到 `409` + `ROOM_FULL`；房内收到 `player.joined` |
| M2 阶段时钟 | P0 | 30 秒准备、满员打断、3 秒开局、60 秒对局 | 只由服务端按 `deadlineAt` / `gameEndsAt` 单向推进状态 |
| M3 抢币计分 | P0 | 游戏循环、原子抢占、主视图 | 同一 `coinId` 并发抢占只加 1 分；前端计分板不先改分 |
| M4 生命周期 | P1 | 退出、心跳、宽限重连、全员离开关闭 | 主动退出和僵尸清理走同一套退出逻辑 |
| M5 一致性与延迟 | P1 | 幂等、序号补偿、时钟校准、限流、日志补齐 | 丢广播或短时断线后，快照能恢复金币和排行榜 |
| M6 扩展与体验 | P2 | 落库、多实例、重启恢复、观测和动画打磨 | 单实例主路径行为不变；崩溃后按 Redis 绝对时间恢复 |

每个里程碑的任务都要带上该路径的日志：请求进入/发出、状态变更前后、抢占成败。缺日志视为该里程碑未完成。

## 3. P0 核心任务

### M0 骨架可运行

#### P0-01 工程与进程

- 建立前端（React 或 Vue）和后端（Node.js + NestJS 或 Express + Socket.IO）。
- 后端能连接 Redis。PostgreSQL 本阶段不接入。
- 提供健康检查：进程存活且 Redis 可读写。
- 完成定义：本地一条命令启动后端；Redis 断开时健康检查失败并打 `error` 日志。

#### P0-02 统一响应与时间

- 所有 HTTP 业务响应使用 `success`、`data`、`error`、`serverTime`。
- `serverTime` 为服务端 Unix 毫秒。WebSocket 业务回执和广播同样携带 `serverTime`。
- 完成定义：成功和失败响应形状一致；失败带稳定 `error.code`，不能只返回自然语言。

#### P0-03 日志骨架

- 按 `RULE.md` 第 1 节输出 `[IN]`、`[OUT]`、`[STATE]`。
- 日志可包含令牌后 6 位，禁止打印完整 `playerToken` 和签名密钥。
- 开发环境默认 `debug`。
- 完成定义：一次成功加入和一次失败加入都能在日志里对上 `requestId`、状态码和耗时。

### M1 进房闭环

#### P0-04 参数与房间标识

- `POST /api/rooms/join` 接收 `roomCode`、`nickname`。
- `roomCode` 必须是 6 位大写字母或数字；`nickname` 长度 1～20，拒绝空串和纯空格。
- 非法参数返回 `400`，不创建房间、不增加人数。
- 同一 `roomCode` 对应唯一 `roomId`。房间字段至少包括 `roomId`、`roomCode`、`status`、`playerCount`、`deadlineAt`、`eventSeq`、`createdAt`。
- 完成定义：非法房间号、空昵称、超长昵称均返回 `400`，Redis 中无半成品成员。

#### P0-05 原子加入与人数上限

- 用一条 Redis Lua 完成：校验房间状态、标准化昵称是否占用、在线人数是否小于 5、写入成员。
- 禁止先 `GET` 人数再单独写入。
- 房间不存在时在同一原子操作中创建，初始状态 `WAITING`。
- 首个玩家写入后状态变为 `PREPARING`。准备截止时间用 `SET NX` 只写一次：`deadlineAt = serverNow + 30000`。
- 玩家字段：`playerId`、`roomId`、`nickname`、`score=0`、`connectionState=ONLINE`、`joinedAt`、`lastSeenAt`。
- 昵称按大小写不敏感唯一，冲突返回 `409` + `NICKNAME_TAKEN`。
- 已有 5 人返回 `409` + `ROOM_FULL`，`playerCount` 保持 5，不广播第 6 人。
- `COUNTDOWN`、`PLAYING`、`FINISHED` 拒绝加入，返回 `409` + `ROOM_STARTED`。`CLOSED` 返回 `ROOM_CLOSED`。
- 完成定义：并发加入超过 5 人时，成功人数恰好为 5；失败响应码稳定。

#### P0-06 令牌、连接与快照

- 加入成功签发短期签名 `playerToken`，绑定 `roomId` 和 `playerId`。
- 响应包含 `roomId`、`playerId`、`playerToken`、`wsUrl`、`snapshot`。`snapshot` 至少含 `status`、`deadlineAt`、`players`、`activeCoin`。
- 客户端携带令牌发送 `room.resume`。校验失败拒绝连接。
- 连接成功后下发 `room.snapshot`。
- 广播 `player.joined`，包含 `player` 和 `playerCount`。
- 所有广播带 `roomId`、`eventSeq`、`serverTime`。`eventSeq` 在房间内单调递增。
- 完成定义：第二个玩家加入后，已在房内的连接能收到 `player.joined`，快照人数与 Redis 一致。

#### P0-07 房间大厅

- 页面只收集房间号和昵称。成功后再进入准备/游戏视图。
- 失败时展示服务端错误码对应的明确提示，不把满员请求静默丢掉。
- 完成定义：大厅不能直接进入 5×5；加入失败停留在大厅。

### M2 阶段时钟

#### P0-08 准备与满员打断

- 状态只能前进：`WAITING → PREPARING → COUNTDOWN → PLAYING → FINISHED → CLOSED`。
- 转换由服务端用 Lua 条件更新完成。CAS 失败时记录期望状态、实际状态和目标状态。
- 准备阶段第 5 人加入成功后，立即把状态改为 `COUNTDOWN`，重写 `deadlineAt = serverNow + 3000`，原 30 秒剩余时间作废。
- 准备截止时若仍未满员，按当前人数进入 `COUNTDOWN`，即使只剩 1 人也开局。
- `COUNTDOWN` 期间拒绝新玩家，不补位。有人退出也不取消这 3 秒。
- 广播 `game.countdown`，字段为 `phase`、`deadlineAt`。`phase` 取 `PREPARING` 或 `COUNTDOWN`。
- 完成定义：4 人房间等到 `deadlineAt` 才进入 3 秒倒计时；5 人房间在第 5 人加入的同一次处理中进入 3 秒倒计时。

#### P0-09 开局、对局与结束

- 每个房间同一时刻只有一个逻辑循环所有者。本阶段可用进程内调度器，但每次触发都必须回读 Redis 的状态和绝对时间，不能只相信内存 `setTimeout`。
- `COUNTDOWN` 到达 `deadlineAt` 后写入 `PLAYING`、`gameStartedAt`、`gameEndsAt = serverNow + 60000`，广播 `game.started`。
- 到达 `gameEndsAt` 后先原子切到 `FINISHED`，再停止生成金币、使当前金币失效，并广播 `game.finished`（含 `finishedAt`、`leaderboard`）。
- `FINISHED` 之后拒绝加分。
- 调度日志包含房间 ID、当前状态、下次计划时间和本次动作。
- 完成定义：各客户端看到的阶段以同一次服务端事件和同一个 `deadlineAt` 为准；倒计时阶段不刷金币。

#### P0-10 倒计时展示

- 前端只渲染服务端状态和 `deadlineAt`，不用本地 `setTimeout` 决定开局或结束。
- 展示值使用 `deadlineAt - (Date.now() + clockOffset)`。本阶段 `clockOffset` 至少用一次 `serverTime - Date.now()` 估算。
- 准备倒计时和 3 秒倒计时必须更新各自的 `deadlineAt`，禁止两个阶段共用一个不刷新的本地计时器。
- 完成定义：满员打断后，画面从 30 秒区间切到 3、2、1，而不是把原倒计时走完。

### M3 抢币计分

#### P0-11 游戏循环与金币

- 仅 `PLAYING` 且 `serverNow < gameEndsAt` 时生成金币。
- 随机间隔使用 1～3 秒。每次生成全局唯一 `coinId`、`row`/`col`（0～4）、`spawnedAt`、`expiresAt`。
- 同一房间同时最多一枚有效金币。新金币生成前把旧金币标为 `EXPIRED` 并广播 `coin.removed`。
- 广播 `coin.spawned`：`coinId`、`row`、`col`、`spawnedAt`、`expiresAt`。
- Redis 当前金币放在 `room:{roomId}:coin`。
- 完成定义：任意时刻房间内 `ACTIVE` 金币数量为 0 或 1；旧 `coinId` 不能再被抢成功。

#### P0-12 原子抢占

- 客户端发送 `coin.claim`：`coinId`、`requestId`、`clickedAt`。`clickedAt` 只记录，不参与胜负。
- 一条 Redis Lua 内完成：
  1. 房间处于 `PLAYING` 且未过 `gameEndsAt`。
  2. 玩家属于该房间且在线。
  3. 当前有效金币 ID 与请求一致。
  4. `SET claim:{roomId}:{coinId} playerId NX EX <ttl>`。
  5. 仅成功者 `ZINCRBY room:{roomId}:scores 1 playerId`，金币改为 `CLAIMED`，写入 `claimedBy`、`claimedAt`。
- 抢占锁的键是 `coinId`，不是格子坐标，也不是 `requestId`。
- 成功后广播 `coin.claimed` 和 `score.updated`。分数只加 1。
- 失败原因只使用：`INVALID_COIN`、`ALREADY_CLAIMED`、`GAME_NOT_PLAYING`、`GAME_ENDED`、`PLAYER_NOT_ACTIVE`。
- 回执包含 `requestId`、`accepted`、`reason`、`winnerId`、`serverTime`。
- 抢到和没抢到都打日志。
- 完成定义：相差约 10ms 的两个请求抢同一金币时，恰好一个 `accepted=true`，房间总分只增加 1。

#### P0-13 主视图与点击锁定

- 主视图固定为顶部 60 秒倒计时、左侧积分榜、中央 5×5。
- 权威状态与乐观效果分开。积分、房间状态、当前金币只来自服务端；乐观效果只用于碎裂、变灰、飞出动画。
- 某个 `coinId` 第一次点击后立即标为 `pending`/`locked`，在回执到达前忽略后续点击。
- 1 秒内不得对同一金币发出多次 `coin.claim`。
- 成功则保留动画，等 `coin.claimed` 或 `score.updated` 再改积分榜。失败时：金币仍有效则恢复展示；已被他人抢走则保持消失。
- 前端页面切换、锁定/解锁、动画回滚按 `RULE.md` 打印前后状态。
- 完成定义：连点同一金币不会打出一串抢占请求；积分榜不会在服务端确认前跳动。

### P0 完成线

M0～M3 全部完成后，必须能跑通第 6 节的基本冒烟。冒烟未过，不得开始 P1。

## 4. P1 重要任务

### M4 生命周期

#### P1-01 主动退出

- 实现 `POST /api/rooms/{roomId}/leave`，请求头 `Authorization: Bearer <playerToken>`。
- 校验令牌与路径中的 `roomId`、令牌内的 `playerId` 一致。
- 退出逻辑幂等：玩家已不在房间时仍返回成功。
- 正式退出后广播 `player.left`，包含 `playerId`、`reason`、`playerCount`。主动退出的 `reason` 使用 `LEAVE`。
- 完成定义：重复调用 leave 不使 `playerCount` 变成负数，也不重复广播。

#### P1-02 断线宽限与重连

- WebSocket 意外断开后，玩家进入 `RECONNECTING`，开始 10 秒宽限期，不立即减人数。
- 宽限期内用同一 `playerToken` 执行 `room.resume`，恢复原 `playerId`、昵称和积分，状态回到 `ONLINE`。
- 宽限期结束才移除玩家并广播 `player.left`，`reason` 使用 `GRACE_TIMEOUT`。
- 提供 `GET /api/rooms/{roomId}`，返回状态、截止时间、玩家、积分和当前金币，供重连覆盖本地权威状态。
- 抢占进行中断线：Lua 若已成功，分数保留，重连快照可见。
- 完成定义：10 秒内重连后积分不变、人数不减；超过 10 秒后原令牌不能再占着名额。

#### P1-03 心跳与僵尸清理

- 服务端每 10 秒发送 WebSocket `ping`，客户端回复 `pong`。
- 每次心跳刷新 `presence:{roomId}:{playerId}`，TTL 30 秒，并更新 `lastSeenAt`。
- 连续 30 秒无响应则断开连接，进入与 P1-02 相同的 10 秒宽限期。
- 后台清理器扫描过期在线记录，调用与主动退出相同的移除逻辑，`reason` 使用 `ZOMBIE`。
- 对局中所有玩家都正式离开时，停止循环并进入 `CLOSED`。准备阶段允许剩 1 人继续走完倒计时，这与“对局中全员离开才提前关闭”区分开。
- 完成定义：只关浏览器、不发 leave 的连接，会在心跳超时加宽限期之后从房间消失。

### M5 一致性与延迟

#### P1-04 请求幂等与服务端限流

- `request:{playerId}:{requestId}` 保存首次抢占结果，TTL 2 分钟。
- 同一 `playerId + requestId` 重放时返回首次回执，不再次执行抢占，不加分。
- 不同 `requestId` 抢同一已领取金币返回 `ALREADY_CLAIMED`，不加分。
- 服务端对每个玩家的 `coin.claim` 做频率限制，作为前端锁定之外的第二道防线。
- 限制事件体大小。缺失 `coinId` 或 `requestId` 时拒绝且不改分。
- 完成定义：同一请求重放前后，该玩家分数和 `claim:{roomId}:{coinId}` 的获胜者都不变。

#### P1-05 序号补偿

- 客户端记录已应用的 `eventSeq`。
- 发现序号跳跃时发送 `room.sync`，载荷 `{ lastEventSeq }`。
- 服务端返回权威 `room.snapshot`，客户端用它覆盖积分、房间状态和当前金币，再按规则恢复或丢弃乐观动画。
- 广播失败不回滚 Redis。权威数据只以 Redis 为准。
- 完成定义：丢弃一次 `coin.spawned` 或 `score.updated` 后，同步能把画面拉回服务端状态。

#### P1-06 网络延迟

- 多次采样 `serverTime`，用低延迟样本估算 `clockOffset`。
- 客户端收到金币时，若 `serverNow >= expiresAt`，不渲染。
- 文档和实现都明确：画面上的出现时间晚于 `spawnedAt`；胜负只看服务端完成 Lua 的顺序。
- 金币过期、被替换或对局结束时广播 `coin.removed`，`reason` 分别为 `EXPIRED`、`REPLACED`、`GAME_FINISHED`。
- 完成定义：人为延迟到达的过期金币不会出现在 5×5 上，也不会被本地当成可点击目标。

#### P1-07 规则补齐

- 补齐 P0 路径上尚未成对出现的状态日志、循环日志和清理日志。
- 非法 JSON、超大 body 返回失败且进程不退出。
- 不信任客户端传入的分数、人数、房间状态、坐标和 `clickedAt`。坐标越界不能改变抢占结果。
- 完成定义：用日志可以独立复盘一次加入、一次阶段切换和一次抢占，无需打断点。

## 5. P2 优化任务

### M6 扩展与体验

#### P2-01 终态与历史落库

- 结算完成后房间可进入 `CLOSED`。关闭后的房间键保留 10 分钟，便于查询终态。
- PostgreSQL 只异步保存已结束对局和排行榜，不进入抢金币临界路径。
- 落库失败不影响 Redis 中已经确定的分数，并打 `error` 日志。
- 完成定义：`FINISHED` 之后分数、金币和定时器不再变化；数据库不可用时对局仍能正常结束。

#### P2-02 多实例与重启恢复

- 游戏循环使用 `loop-owner:{roomId}` 租约。未持有租约的实例不得生成金币或切换阶段。
- 租约过期后其他实例可以接管。
- 跨实例广播使用 Redis Pub/Sub 或 Socket.IO Redis Adapter。
- 进程重启后读取 Redis 的 `status`、`deadlineAt`、`gameEndsAt` 和当前金币：未到期则继续，已到期则结算。不得假设内存定时器还在。
- 阶段切换继续使用 Lua CAS，保证多个实例同时触发时只有一个成功并广播。
- 完成定义：杀掉持有循环的进程后，房间仍按原 `gameEndsAt` 结束；不会出现两枚并发有效金币。

#### P2-03 观测与体验

- 记录 `roomId`、`coinId`、`playerId`、`requestId`、`serverReceiveAt`、结果和耗时。
- 暴露或可查询这些指标：在线房间数、加入拒绝数、抢占成功率、重复点击率、断线率、循环漂移、Lua 耗时。
- 打磨金币碎裂、变灰、飞出动画和积分榜排序展示。动画失败不得阻塞权威状态渲染。
- 生产环境日志默认 `info`；抢金币结果和状态跳转仍要保留。
- 完成定义：动画和指标关闭时，第 6 节冒烟仍然通过。

## 6. 基本冒烟测试

冒烟证明 M0～M3 的架构主路径能跑通。默认使用真实时长：准备 30 秒、开局 3 秒、对局 60 秒。快速冒烟走满员打断，从而不必干等 30 秒；未满员分支单独执行。测试夹具可以注入服务端时钟，但生产配置里的三个时长不能改。

前置：Redis 已启动；后端已启动；打开 6 个客户端或 6 条脚本连接，房间号固定为 `ABCD12`，昵称各不相同。

### 6.1 快速冒烟

| 编号 | 操作 | 通过标准 |
|---|---|---|
| SM-01 | 请求健康检查 | 返回成功；Redis 不可用时返回失败 |
| SM-02 | 用空昵称、5 位房间号各加入一次 | 两次都是 `400`；`ABCD12` 尚未出现成员 |
| SM-03 | 玩家 A 加入 | `200`；`status=PREPARING`；`deadlineAt` 约为服务端当前时间加 30 秒；日志有 `WAITING → PREPARING` |
| SM-04 | 玩家 B 加入并保持 A 的 WebSocket | A 收到 `player.joined`；`playerCount=2`；`deadlineAt` 不变；`eventSeq` 变大 |
| SM-05 | C、D、E 依次加入 | E 加入后立即 `COUNTDOWN`；新的 `deadlineAt` 约为当前时间加 3 秒；全员收到 `game.countdown` |
| SM-06 | 玩家 F 用新昵称加入 | `409`，`error.code=ROOM_FULL`；房内仍是 5 人；没有 F 的 `player.joined` |
| SM-07 | 等待约 3 秒 | 状态变为 `PLAYING`；存在 `gameStartedAt` 和 `gameEndsAt`；`gameEndsAt - gameStartedAt = 60000`；此后才出现第一枚金币 |
| SM-08 | 观察第一枚 `coin.spawned` | 有唯一 `coinId`；`row`、`col` 都在 0～4；5×5 只显示这一枚 |
| SM-09 | A、B 在约 10ms 内对同一 `coinId` 发送 `coin.claim` | 恰好一个 `accepted=true`；另一个为 `ALREADY_CLAIMED`；两人分数之和增加 1；只广播一次 `coin.claimed` |
| SM-10 | 获胜客户端在动画出现后、回执到达前查看积分榜 | 积分榜仍是旧分数；收到 `score.updated` 后才变为新分数 |
| SM-11 | 对同一金币连续点击 | 该 `coinId` 在 1 秒内只有一次 `coin.claim` 发出 |
| SM-12 | 等到 `gameEndsAt` 后再抢一次 | 状态为 `FINISHED`；收到 `game.finished`；该次请求为 `GAME_ENDED` 或 `GAME_NOT_PLAYING`；全员分数不再变化；不再出现新的 `ACTIVE` 金币 |

SM-01～SM-12 全部通过，才算 P0 架构冒烟通过。

### 6.2 未满员分支

使用另一个房间号 `EFGH34`，只加入 2 名玩家。

| 编号 | 操作 | 通过标准 |
|---|---|---|
| SM-13 | 等待准备阶段 `deadlineAt` | 进入 `COUNTDOWN` 而不是继续等待第 5 人，也不是直接 `PLAYING` |
| SM-14 | 再等待约 3 秒 | 以 2 人进入 `PLAYING`，并开始刷金币 |

### 6.3 冒烟失败时先查这些点

- 加入是否分成了“查询人数”和“写入成员”两次操作。
- 第 5 人加入后是否仍沿用原来的 30 秒 `deadlineAt`。
- 开局是否由某个浏览器本地计时器触发。
- 抢占是否没用 `coinId` 做 `SET NX`，或加分发生在锁之外。
- 前端是否在发送 `coin.claim` 之前就改了积分榜。
- 结束后是否还在调度下一次金币。

## 7. 阶段验收对照

| 验收项 | 落在哪个阶段 |
|---|---|
| 并发 100 个请求抢同一金币，只成功 1 次，总分加 1 | M3，冒烟 SM-09 先覆盖双人；100 并发在 M3 完成后补测 |
| 5 人成功，第 6 人 `ROOM_FULL` | M1，冒烟 SM-05、SM-06 |
| 满员立即转入 3 秒倒计时 | M2，冒烟 SM-05 |
| 未满员等满 30 秒后按当前人数开局 | M2，冒烟 SM-13、SM-14 |
| 对局严格 60 秒，结束后不能加分 | M2、M3，冒烟 SM-07、SM-12 |
| 关浏览器后的僵尸玩家被清理 | M4 |
| 丢广播或短时断线后快照恢复 | M4、M5 |
| 前端看到金币的时间晚于 `spawnedAt`，过期金币不展示 | M5 |
| 进程重启和多实例不重复刷币、不重复结算 | M6 |

M3 结束后先执行第 6 节。M4、M5、M6 每阶段完成时，除本阶段任务的完成定义外，再重跑 SM-03～SM-12，确认主路径没有回退。

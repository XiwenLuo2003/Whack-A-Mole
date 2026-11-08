# 多人同屏打地鼠——架构设计

## 1. 设计目标

- 每个房间最多 5 名在线玩家，加入与退出状态准确。
- 首人加入后开始 30 秒准备；满 5 人时立即转入 3 秒倒计时；30 秒结束后按当前人数开局。
- 游戏持续 60 秒，服务端按随机间隔生成金币并实时广播。
- 同一金币只能被一名玩家抢到，积分以服务端结果为唯一依据。
- 支持断线识别、短时重连、心跳清理和服务端时间校准。

## 2. 总体架构

```text
浏览器（React/Vue）
  ├─ HTTP：加入房间、获取初始状态
  └─ WebSocket：倒计时、金币、抢夺、排行榜、成员变更
              │
              ▼
应用服务（Node.js + NestJS/Express + Socket.IO）
  ├─ Room Service：人数限制、成员生命周期
  ├─ Game Service：房间状态机、游戏循环
  ├─ Claim Service：金币原子抢占、计分
  └─ Presence Service：心跳、断线与重连
              │
        ┌─────┴─────┐
        ▼           ▼
Redis（实时状态）   PostgreSQL（可选持久化）
原子锁、房间、积分、  对局结果、历史战绩
在线状态、事件分发
```

Redis 是进行中对局的实时数据源。多实例部署时，通过 Redis Lua 脚本完成“校验金币 + 抢占 + 加分”的单次原子操作，并使用 Redis Pub/Sub 或 Socket.IO Redis Adapter 跨实例广播。PostgreSQL 不参与抢金币临界路径，只异步保存已结束对局。

## 3. 房间状态机

```text
WAITING ──首人加入──> PREPARING_30S
PREPARING_30S ──满5人或30秒结束──> COUNTDOWN_3S
COUNTDOWN_3S ──倒计时结束──> PLAYING
PLAYING ──60秒结束──> FINISHED
FINISHED ──结算完成/无人在线──> CLOSED
```

状态转换只能由服务端执行。

| 状态 | 可加入 | 可抢金币 | 说明 |
|---|---:|---:|---|
| `WAITING` | 是 | 否 | 尚无玩家或房间刚创建 |
| `PREPARING` | 是，最多 5 人 | 否 | 30 秒准备阶段 |
| `COUNTDOWN` | 否 | 否 | 最后 3 秒，名单冻结 |
| `PLAYING` | 否 | 是 | 60 秒游戏阶段 |
| `FINISHED` | 否 | 否 | 已停止生成金币并完成结算 |

关键规则：

1. 加入操作通过 Redis Lua 原子校验当前状态、昵称和人数，再写入成员，禁止“先查人数再加入”。
2. 第一个玩家加入时，以 `SET NX` 方式创建准备截止时间，确保只启动一次准备计时。
3. 第 5 名玩家加入成功后，服务端取消逻辑上的 30 秒等待，原子切换到 `COUNTDOWN` 并写入新的 3 秒截止时间。
4. 计时使用服务端绝对时间戳 `deadlineAt`，前端只负责展示，避免多个定时器累积误差。
5. `COUNTDOWN` 开始后不再补位；玩家退出不终止倒计时。游戏中所有玩家离开则提前关闭房间。

## 4. 核心流程

### 4.1 加入与退出

1. 客户端提交房间号和昵称。
2. 服务端校验格式，并原子判断房间状态、昵称是否重复、在线人数是否小于 5。
3. 加入成功后签发短期 `playerToken`，建立 WebSocket 连接，返回完整房间快照。
4. 服务端广播 `player.joined`；主动退出或断线超时后广播 `player.left`。
5. WebSocket 意外断开后玩家进入宽限期；在 10 秒内携带同一令牌重连，可恢复原 `playerId` 和积分。宽限期结束才正式移除。

加入失败必须返回明确错误：`ROOM_FULL`、`ROOM_STARTED`、`NICKNAME_TAKEN` 或 `ROOM_CLOSED`。

### 4.2 游戏循环

- 每个房间只有一个逻辑循环所有者。单实例可使用进程内调度器；多实例使用带租约的 Redis 分布式锁选主。
- 进入 `PLAYING` 后写入 `gameEndsAt = serverNow + 60s`，随后按可配置随机间隔（建议 1～3 秒）调度金币。
- 每次生成金币时创建全局唯一 `coinId`、随机坐标和服务端时间，并广播 `coin.spawned`。
- 本设计默认每个房间同一时刻最多存在一枚有效金币：新金币生成前使旧金币失效；金币被抢后立即广播消失，并开始安排下一次生成。
- 到达 `gameEndsAt` 后先原子切换为 `FINISHED`，再停止调度、使当前金币失效、广播最终排行榜并异步落库。
- 进程重启后根据 Redis 中的状态与绝对截止时间恢复或直接结算，不能依赖内存定时器作为唯一事实。

### 4.3 金币抢占与计分

客户端点击步骤：

1. 首次点击后立即将该 `coinId` 标记为 `pending`，忽略后续重复点击。
2. 播放碎裂/变灰动画，但不修改积分。
3. 发送 `coin.claim`，携带 `roomId`、`coinId` 和客户端请求 ID。
4. 收到成功结果后保留动画；失败则回滚金币展示（若金币仍有效）。排行榜只接受服务端广播。

服务端在一段 Redis Lua 脚本中完成：

1. 校验房间处于 `PLAYING` 且未超过 `gameEndsAt`。
2. 校验玩家属于该房间且在线。
3. 校验当前有效金币 ID 与请求一致。
4. 用 `SET claim:{roomId}:{coinId} playerId NX EX <ttl>` 抢占金币。
5. 仅抢占成功者执行 `HINCRBY score:{roomId} playerId 1`，并将金币标记为已领取。
6. 返回获胜者与最新分数。

以上步骤必须在同一 Lua 脚本内完成。即使两个请求相差 10ms 或由不同应用实例处理，也只有一个请求成功。`requestId` 用于幂等响应，不可代替 `coinId` 的唯一抢占锁。

### 4.4 心跳与僵尸清理

- 服务端每 10 秒发送 WebSocket `ping`，客户端自动回复 `pong`。
- 连续 30 秒无响应则断开连接并进入 10 秒重连宽限期。
- 每次心跳更新 `presence:{roomId}:{playerId}` 的 TTL。
- 后台清理器兜底扫描已过期在线记录，执行统一退出逻辑，避免异常进程留下僵尸玩家。

## 5. 接口设计

统一响应：

```json
{
  "success": true,
  "data": {},
  "error": null,
  "serverTime": 1793325600000
}
```

### 5.1 HTTP 接口

#### `POST /api/rooms/join`

请求：

```json
{
  "roomCode": "ABCD12",
  "nickname": "玩家A"
}
```

成功 `200`：

```json
{
  "success": true,
  "data": {
    "roomId": "room_uuid",
    "playerId": "player_uuid",
    "playerToken": "signed_token",
    "wsUrl": "/ws",
    "snapshot": {
      "status": "PREPARING",
      "deadlineAt": 1793325630000,
      "players": [],
      "activeCoin": null
    }
  },
  "error": null,
  "serverTime": 1793325600000
}
```

失败使用 `409 Conflict`（房间满、昵称重复、已开局）或 `400 Bad Request`（参数非法）。

#### `GET /api/rooms/{roomId}`

使用 `Authorization: Bearer <playerToken>` 获取重连所需的权威房间快照，包括状态、截止时间、玩家、积分和当前金币。

#### `POST /api/rooms/{roomId}/leave`

主动退出。接口需幂等；重复调用仍可返回成功。

### 5.2 WebSocket 客户端事件

| 事件 | 载荷 | 说明 |
|---|---|---|
| `room.resume` | `{ playerToken }` | 连接或断线重连 |
| `coin.claim` | `{ coinId, requestId, clickedAt }` | 尝试抢金币；`clickedAt` 仅用于观测，不决定胜负 |
| `room.sync` | `{ lastEventSeq }` | 请求最新权威快照 |

`coin.claim` 回执：

```json
{
  "requestId": "request_uuid",
  "accepted": false,
  "reason": "ALREADY_CLAIMED",
  "winnerId": "player_uuid",
  "serverTime": 1793325612345
}
```

可用失败原因：`INVALID_COIN`、`ALREADY_CLAIMED`、`GAME_NOT_PLAYING`、`GAME_ENDED`、`PLAYER_NOT_ACTIVE`。

### 5.3 WebSocket 服务端事件

| 事件 | 关键字段 | 说明 |
|---|---|---|
| `room.snapshot` | `status, deadlineAt, players, scores, activeCoin` | 首连、重连或补偿同步 |
| `player.joined` | `player, playerCount` | 新玩家加入 |
| `player.left` | `playerId, reason, playerCount` | 玩家正式退出 |
| `game.countdown` | `phase, deadlineAt` | 30 秒准备或 3 秒开局倒计时 |
| `game.started` | `startedAt, gameEndsAt` | 60 秒游戏开始 |
| `coin.spawned` | `coinId, row, col, spawnedAt, expiresAt` | 新金币生成 |
| `coin.claimed` | `coinId, winnerId, score, claimedAt` | 抢占成功及权威积分 |
| `coin.removed` | `coinId, reason` | 过期、替换或结束时移除 |
| `score.updated` | `playerId, score, rank` | 权威积分变化 |
| `game.finished` | `finishedAt, leaderboard` | 对局结束 |
| `room.error` | `code, message` | 可处理的业务错误 |

所有广播带单调递增的 `eventSeq`、`roomId` 和 `serverTime`。客户端发现序号跳跃时发送 `room.sync`，避免丢包造成状态不一致。

## 6. 数据字典

### 6.1 业务对象

#### Room

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `roomId` | UUID | 主键 |
| `roomCode` | string(6) | 唯一、只允许大写字母和数字 |
| `status` | enum | `WAITING/PREPARING/COUNTDOWN/PLAYING/FINISHED/CLOSED` |
| `playerCount` | int | 0～5，仅作原子校验或派生值 |
| `deadlineAt` | int64 | 当前阶段截止时间，Unix ms |
| `gameStartedAt` | int64? | 游戏实际开始时间 |
| `gameEndsAt` | int64? | 游戏截止时间 |
| `eventSeq` | int64 | 房间事件序号 |
| `createdAt` | int64 | 创建时间 |

#### Player

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `playerId` | UUID | 主键 |
| `roomId` | UUID | 所属房间 |
| `nickname` | string(1..20) | 房间内大小写不敏感唯一 |
| `score` | int | 初始为 0，只能由服务端增加 |
| `connectionState` | enum | `ONLINE/RECONNECTING/OFFLINE` |
| `joinedAt` | int64 | 加入时间 |
| `lastSeenAt` | int64 | 最近心跳时间 |

#### Coin

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `coinId` | UUID/ULID | 全局唯一 |
| `roomId` | UUID | 所属房间 |
| `row` | int | 0～4 |
| `col` | int | 0～4 |
| `status` | enum | `ACTIVE/CLAIMED/EXPIRED` |
| `spawnedAt` | int64 | 服务端生成时间 |
| `expiresAt` | int64 | 有效期截止时间 |
| `claimedBy` | UUID? | 获胜玩家 |
| `claimedAt` | int64? | 服务端判定时间 |

### 6.2 Redis Key

| Key | 类型 | 内容/TTL |
|---|---|---|
| `room:{roomId}` | Hash | 房间状态与各阶段时间；房间关闭后保留 10 分钟 |
| `room:{roomId}:players` | Hash | `playerId -> Player JSON` |
| `room:{roomId}:nicknames` | Hash | 标准化昵称到 `playerId` 的映射 |
| `room:{roomId}:scores` | Sorted Set | `playerId -> score`，支持排行榜 |
| `room:{roomId}:coin` | Hash | 当前有效金币 |
| `claim:{roomId}:{coinId}` | String | 抢占成功的 `playerId`；TTL 覆盖对局生命周期 |
| `request:{playerId}:{requestId}` | String | 幂等结果；TTL 建议 2 分钟 |
| `presence:{roomId}:{playerId}` | String | 在线租约；TTL 30 秒 |
| `loop-owner:{roomId}` | String | 游戏循环实例及租约 |

## 7. 前端状态与一致性

- 服务端数据分为 `authoritativeState`（积分、房间状态、金币）和 `optimisticEffects`（点击动画），禁止直接乐观增加积分。
- 点击锁按 `coinId` 保存；收到回执、金币被他人抢走或同步快照后释放。
- 前端根据 `deadlineAt - (Date.now() + clockOffset)` 展示倒计时；`clockOffset` 由多次服务端时间采样取低延迟样本估算。
- 金币是否抢到以服务端接收并完成原子脚本的顺序为准，不能使用客户端 `clickedAt`，否则客户端可伪造时间且设备时钟不一致。
- 网络延迟会导致不同玩家看到金币的时刻不同。服务端统一发送 `spawnedAt/expiresAt`，客户端收到已过期金币时不展示；延迟只影响体验，不改变服务端唯一裁决。

## 8. 异常处理与边界

- 服务端收到重复请求：通过 `playerId + requestId` 返回相同结果。
- 玩家在抢占过程中断线：原子操作若已成功，积分仍然有效；重连后通过快照恢复。
- 游戏结束与抢占同时发生：Lua 脚本比较服务端当前时间和 `gameEndsAt`；截止时间后拒绝加分。
- 多个实例同时触发阶段转换：使用状态条件更新/Lua compare-and-set，只有一个实例成功并广播事件。
- 广播失败：权威状态仍在 Redis；客户端依靠 `eventSeq` 检测并执行快照补偿。
- 应用进程崩溃：循环租约过期后由其他实例接管，并基于绝对时间恢复。

## 9. 安全与可观测性

- `playerToken` 绑定 `roomId/playerId`，短期有效并签名；所有 HTTP 与 WebSocket 操作都校验令牌。
- 限制昵称长度、事件体大小和每玩家请求频率；服务端限流作为前端节流之外的第二道防线。
- 记录 `roomId、coinId、playerId、requestId、serverReceiveAt、result、latency`，便于复盘并发争议。
- 核心指标：在线房间数、加入拒绝数、金币抢占成功率、重复点击率、WebSocket 断线率、游戏循环漂移、Lua 执行耗时。

## 10. 验收重点

1. 并发 100 个请求抢同一金币时，恰好 1 个成功且总积分只增加 1。
2. 5 个玩家并发加入只允许前 5 名成功，第 6 名明确收到 `ROOM_FULL`。
3. 第 5 人加入后立即转入 3 秒倒计时，不再等待原 30 秒。
4. 未满员时 30 秒结束后按当前人数进入 3 秒倒计时。
5. 游戏严格按服务端时间运行 60 秒，结束后任何请求均不能加分。
6. 浏览器异常关闭后，玩家在心跳超时与宽限期结束后被清理。
7. 丢失广播或短时断线后，客户端可通过快照恢复正确金币和排行榜。

# Relay HTTP / WebSocket API

Base URL 是 Relay 的 HTTP 或 HTTPS 地址；本机开发默认为 `http://127.0.0.1:8787`。Expo Web 开发页直接连接 Relay，跨来源访问需加入 `RELAY_ALLOWED_ORIGINS`；生产网页由 Relay 同源提供。完整数据约束和 TypeScript 类型见 `packages/protocol/src/index.ts`，状态同步时序见 [protocol.md](protocol.md)。

## 认证和错误

微信接入 API 只接受普通账号的控制端 session；管理员和设备限定 session 无权访问。所有返回使用 `Cache-Control: no-store`，不返回 Bot token、上下文令牌或消息游标。完整使用说明见 [微信 ClawBot](weixin.md)。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/weixin` | 当前账号绑定、激活、连接状态、通知与续做开关、待发送数和错误代码 |
| POST | `/v1/weixin/login` | 创建当前账号的扫码流程，返回 `loginId`、二维码 PNG data URL 和五分钟有效期 |
| POST | `/v1/weixin/login/:loginId/poll` | 查询本账号二维码状态，可带 `{verifyCode}`；微信状态轮询可能等待 35 秒 |
| PUT | `/v1/weixin` | 保存 `{notifications:boolean,replies:boolean}` |
| DELETE | `/v1/weixin` | 解除当前账号绑定并清除对应收发队列 |
| POST | `/v1/weixin/test` | 激活后提交测试通知，`queued:true` 表示入队，不代表已投递 |

二维码绑定冲突返回 409 `weixin-bot-already-bound`；其他账号的绑定流程返回 404 `weixin-login-not-found`；未激活测试返回 409 `weixin-not-activated`。微信功能未开启时 GET 返回 `available:false`，其他操作返回 503 `weixin-disabled`。上游错误使用脱敏的固定错误代码。

Web、App 和 PC Agent 均通过控制端账号密码登录；后台管理员使用独立入口 `/v1/admin/auth/login`。两类账号可同名，密码和权限独立。除健康与登录接口外，接口使用 `Authorization: Bearer <session>` 会话凭据。控制端只能访问同账号 PC；管理员不能登录 PC Agent、申请控制 WebSocket ticket 或控制任何设备。跨账号设备请求返回 404。

密码使用加盐 scrypt 哈希。控制端/后台登录按前台续期计算空闲超时，管理员可设为 1–43200 分钟，默认 10080 分钟（7 天）；Agent 仍为 7 天固定有效期。改密和禁用账号会撤销该账号所有会话；退出撤销当前会话。客户端和 Agent 会话相互隔离，Agent 会话只允许访问其 PC。WebSocket 使用绑定当前会话的 60 秒一次性 ticket，连接后 5 秒内发送 client.authenticate。PC WebSocket 使用 Agent 登录会话和 X-Device-Id。登录接口有 IP 与账号尝试限速，公网必须使用 HTTPS/WSS。

HTTP 错误体是 `{ "error": "code" }`。常见状态：`400 invalid-request`、`401 unauthorized`、`403 origin-denied`、`404 device-not-found|snapshot-not-found|command-not-found`、`409 device-offline|stale-device-epoch|command-id-reused`、`429 rate-limited`。WebSocket 协议错误会返回 `{ "type":"error", "code":"..." }` 或关闭连接。调用方不能把命令接受当作 Codex 回答完成。

## REST 路由

| 方法 | 路由 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/health` | 无 | `{ok:true, protocolVersion:1,version}` |
| POST | `/v1/auth/login` | 控制端 `{username,password}` | `{session,expiresAt,role:'user',userId,username}` |
| POST | `/v1/admin/auth/login` | 管理员 `{username,password}` | `{session,expiresAt,role:'admin',userId,username}` |
| POST | `/v1/agents/login` | `{username,password,installationId,name,platform}` | `{session,expiresAt,deviceId,userId}`；自动归属登录账号 |
| POST | `/v1/auth/logout` | 当前客户端会话 | `{loggedOut:true}` |
| POST | `/v1/auth/active` | 当前控制端/后台会话，前台时每 30 秒及离开时调用 | `{expiresAt,idleTimeoutMinutes}`；已过期不续期，Agent 会话不可使用 |
| GET | `/v1/me` | 客户端会话 | `{role,userId}` |
| GET | `/v1/admin/auth-settings` | 管理员 | `{idleTimeoutMinutes}` |
| PUT | `/v1/admin/auth-settings` | 管理员，`{idleTimeoutMinutes}`，1–43200 整数 | 保存并返回设置；按最后前台时间更新现有控制端/后台登录，已过期的不恢复 |
| POST | `/v1/users` | `{username,password}`，管理员 | `{id,name,role}` |
| GET | `/v1/users` | 管理员 | `{users:[{id,name,role,created_at,revoked_at,login_enabled}]}` |
| PUT | `/v1/users/:userId/password` | `{password}`，管理员 | `{reset:true}`；旧会话失效 |
| DELETE | `/v1/users/:userId` | 管理员 | `{revoked:true}`；禁止禁用管理员 |
| GET | `/v1/devices` | 普通账号 | `{devices:[{id,name,platform,created_at,last_seen_at,online}]}` |
| GET | `/v1/agent/:deviceId/session` | 该 PC 的 Agent 会话 | `{active:true}` |
| DELETE | `/v1/devices/:deviceId` | 同账号 | `{revoked:true}` |
| GET | `/v1/devices/:deviceId/snapshot` | 无 | `{online,snapshot}` |
| GET | `/v1/devices/:deviceId/catalog` | 无 | `{catalog:{protocolVersion,deviceId,generatedAt,projects,threads,models?}}` |
| GET | `/v1/devices/:deviceId/threads/:threadId/turns` | 可选 `?cursor=<opaque-cursor>` | `{threadId,turns,nextCursor,generatedAt}` |
| POST | `/v1/ws/tickets` | 无 | `{ticket,expiresAt}` |
| POST | `/v1/devices/:deviceId/commands` | `RemoteCommand` | `command.accepted` 或 `command.result` |
| GET | `/v1/devices/:deviceId/commands/:commandId` | 无 | `{status,result}` |

账号名称在同一类型中忽略大小写且唯一；密码为 12–128 字符。`/v1/users` 系列只操作控制端账号，不能重置管理员密码。installationId 为 PC 本地 UUID，同一账号下重新登录保持 deviceId，并撤销该安装的旧会话。旧用户和内容保留；管理员旧设备仍保留，但不可继续通过管理员身份控制，需要新建控制端账号后重新登录 PC。

### 管理员与服务器更新

以下接口只接受后台管理员会话：

| 方法 | 路由 | 行为 |
| --- | --- | --- |
| GET/POST | `/v1/admin/accounts` | 列出/创建管理员；GET 返回 `{users,currentUserId}`，POST 接受 `{username,password}` |
| PUT | `/v1/admin/accounts/:userId/password` | `{password}`，仅重置管理员；撤销旧登录 |
| DELETE | `/v1/admin/accounts/:userId` | 禁用管理员；当前账号或最后一位有效管理员返回 `409 admin-disable-protected` |
| GET | `/v1/admin/overview` | 账号总量/启用量、在线 PC、在线控制连接及进程运行秒数；不暴露会话内容 |
| GET | `/v1/admin/system/version` | 可选 `?force=true`；返回 `currentVersion,latestVersion,hasUpdate,checkedAt,warning,release,supported,gitSupported,method,tags,autoInstall,job` |
| POST | `/v1/admin/system/update` | `{tag:'vX.Y.Z',action?:'update'|'build'|'restart',jobId?:uuid}`；update 只准备版本；build/restart 匹配已有 jobId 和阶段；不接受 URL 或命令 |
| PUT | `/v1/admin/system/update-settings` | `{method?:'release'|'git',autoInstall?:boolean}`；至少一项；autoInstall 只自动准备 Release，不自动重启；Git 禁止自动准备 |

`UpdateJob` 包含 `id,tag,method,action,commit?,phase,updatedAt,code?`。阶段为 queued/downloading/verifying/installing/fetching/fetched/building/built/restarting/succeeded/failed/rolled-back。fetched 和 built 等待管理员操作，不是正在运行。Git tag 为 `{tag,version,commit}`，只允许比当前版本更高的稳定 tag；Release 准备后同样停在 built，重启始终单独请求。重复处理返回 `409 update-in-progress`，过期 Release 返回 `409 update-not-current`，不可用 tag 返回 `409 tag-not-available`，跳步骤或旧任务 ID 返回 `409 update-step-not-ready`，旧/缺失更新器返回 `409 updater-not-installed`。检查失败保留缓存并设置 warning，禁止准备新版本，已准备好的步骤可继续。只有协议 2 helper 才启用后台安装。详见 [服务器更新](server-update.md)。

登录响应的 `expiresAt` 为当次到期时间；调用 `/v1/auth/active` 后更新。其他 REST 请求、设备数据、WebSocket ping/pong 和票据申请只检查有效性，不续期。设置持久化于 Relay 数据库；旧会话升级时从原有到期时间减去 7 天推算最后活动时间，随后由前台续期更新。缩短超时后，已到期的连接由后续请求/心跳检查关闭。

## 项目目录和历史

Agent 每分钟经官方 app-server 的 `project/list` 与分页 `thread/list` 扫描本机全部已保存项目和交互会话（所有模型提供商，包括已归档会话）；扫描使用独立的短期 app-server，只读取目录和历史，不调用 `thread/resume`、不占用会话 writer。Relay 缓存完整目录，目录与最多 20 个实时会话预览分开。

`projects` 包含 `{id,name,roots,position,updatedAt}`，空项目也保留。`threads` 包含 `{id,title,cwd,projectId,updatedAt,archived,settings?}`。官方列表可能包含同一会话的重复记录；Agent 按会话 ID 去重并保留最新元数据，协议要求项目和会话 ID 各自唯一。项目归属先使用官方 `projectId`；旧会话没有该字段时，按 cwd 与项目最长匹配根目录归属；无法匹配时 `projectId:null`，Web 放在“未归类会话”。默认 app-server 列表包含交互会话，不包含内部子代理会话。

目录最多 1000 项目、10000 会话，且整体不超过 6 MiB。超过上限时整次目录更新失败，不静默截断为近期列表。目录更新时已订阅的浏览器收到 `{type:"catalog.updated",deviceId,generatedAt}`，再取 REST 目录。首次扫描完成前返回 `404 catalog-not-ready`。

历史接口经 Relay 转发 `history.request` 至在线 Agent，每页按倒序返回至多 5 个 turn 和 `nextCursor`；`nextCursor:null` 表示没有更早 turn。客户端反转单页并向前拼接、按 turn ID 去重。PC 离线返回 `409 device-offline`；未知会话返回 `404 thread-not-in-catalog`；超时是 `504 history-timeout`。每台 PC 同时最多 4 个历史请求，整个 Relay 最多 20 个。

历史每个 turn 至多保留 80 项，每项消息/输出至多 32000 字符；超限标记 `truncated`，单页预算 6 MiB。因此分页可以遍历会话的全部 turn，但不是逐字节完整导出。选择未被实时跟踪的会话时，Web 发 `thread.watch` 要求 Agent 按需接入；控制条件仍取自实时快照。桌面 IPC 找不到该会话 owner 时，自动模式尝试本机 app-server；两者都无法接入时暂不可发送。

### 处理时间与消息分段

Remote v1 的实时和历史 turn/item 增加可选字段，旧记录仍可读取。所有远程时间戳统一为 Unix 毫秒；缺少官方记录时省略字段。

| 对象 | 字段 | 含义 |
| --- | --- | --- |
| turn / item | `startedAtMs`, `completedAtMs` | 官方记录的开始和结束时间 |
| turn / item | `durationMs` | 官方记录的耗时，0 也是有效值 |
| item | `phase` | `commentary` 或 `final_answer`；未知时省略 |
| turn | `itemsTruncatedBefore`, `itemsTruncatedAfter` | 当前内容项列表的前方/后方是否有省略内容 |
| turn | `previousMessage` | 实时窗口之前最后一条正文消息的 `{id,startedAtMs?,completedAtMs?}`，供长轮次维持分段计时和折叠标识 |

官方 `thread/turns/list` 的 turn 时间单位是秒，Agent 转成毫秒；逐项时间来自只读 `thread/items/list`，按 turn ID 和 item ID 关联，保留原 turn 项目顺序。每轮最多查询 2 页、每页 100 项、每次超时 5 秒；计时查询不支持、超时或缺少对应记录时，正文仍正常返回。桌面 IPC 直接使用其轮次时间及消息/命令时间表，不写入官方数据库。

`reasoning` 的 `text` 仅来自官方公开的 `summary` 数组，不传送原始 `content` 或推断内部思考。Web 的“用时”是两条正文消息之间的处理间隔，包含思考、等待和工具执行，不等于纯模型思考时长。耗时文字与展开箭头位于分隔线上方。有独立 item 起止时间时，思考摘要条目也显示自身耗时。没有完整边界的截断片段不套用整轮总耗时。

### 模型与 Token

运行中的轮次在一个时间块内按官方 item 顺序显示正文、插话、公开思考摘要和工具调用。结束后过程内容默认收起，用户插话与最终答复仍留在原来的事件位置；展开后可检查完整顺序。完成态耗时取官方整轮 `durationMs` 或完整起止时间，缺失时不估算。历史每轮保留最近 80 项，并优先保留用户消息，前方省略时标记 `itemsTruncatedBefore`。

turn 的可选 `fileChanges` 是最多 40 项的 `{path,additions,deletions,diff,truncated}`。它从官方成功的 `fileChange` 记录提取，按路径汇总，单个差异最多 8192 字符。增删行数是记录补丁的累计值，不等于 Git 工作区最终净差异；命令写文件但运行时未产生 `fileChange` 时没有此列表。执行中统计固定在编辑框上方，结束后使用回复下方原来的面板；点击展开逐文件差异。整体预算超限时先移除差异正文并标记 `truncated`。

实时 thread 和目录 thread 的可选 `settings` 为 `{model,modelProvider,reasoningEffort,collaborationMode?}`，字段可为 `null`，`collaborationMode` 为 `default`/`plan`。它表示后续轮次的当前配置，不是逐轮最终模型记录。目录值来自官方 `thread/list`；实时桌面设置来自 `latestThreadSettings`，独立运行时来自 `thread/read`、已核对的本机 turn context 和 `thread/settings/updated`。实时值优先于目录缓存。

目录的可选 `models` 来自官方分页 `model/list`，每项是 `{model,displayName,supportedReasoningEfforts,defaultReasoningEffort}`，至多 200 项，不含隐藏模型。模型查询失败时省略该字段，项目和会话列表仍可用。自定义 API 提供方可能支持列表外名称，Web 可输入模型名；真实可用性由该提供方处理请求时决定。

`snapshot.runtime.capabilities.modelUpdate:true` 表示 Agent 支持 `thread.model.update`。修改仅作用于后续轮次，通过桌面 owner 的 `thread-follower-update-thread-settings` v2 或独立 app-server 的 `thread/settings/update` 执行。会话必须已被实时观察、owner 可用且 `idle`；`expectedModel` 必须匹配当前设置。原提供方、权限、工作区和协作模式保留，协作模式内的模型同步更新。当前推理强度若不在新模型支持列表中，使用新模型默认强度。

`runtime.capabilities.effortUpdate:true` 表示可提交 `thread.effort.update`。payload 为 `{type,threadId,effort,expectedModel,expectedEffort}`，其中 `expectedEffort` 可以为 `null`，目标档位必须存在于当前模型 `supportedReasoningEfforts` 中。模型或档位不再匹配时分别返回 `stale-model`、`stale-effort`；不支持的目标返回 `unsupported-effort`。桌面 owner 对模型和档位作条件更新；独立运行时恢复并核对原权限，更新协作模式内的 `reasoning_effort`。重置按钮使用当前模型 `defaultReasoningEffort`。

### 模式与交互输入

`runtime.capabilities.collaborationModeUpdate:true` 支持 `thread.mode.update`，payload 为 `{type,threadId,mode,expectedMode,expectedModel,expectedEffort}`。模式只允许 `default`/`plan`，预期模式/档位允许为 `null`；会话必须空闲。模式和档位的过期组合返回 `stale-settings`。切换使用官方内置模式指令，保留模型和权限。见 [会话交互与模式](conversation.md)。

有效用户输入请求的 `details.questions` 保留问题 ID、标题、问题、选项描述、`isOther` 和 `isSecret`；答案是 `{answers:{问题ID:{answers:["回答"]}}}`。`isBlocking:false` 的请求只要仍有效，允许在原轮次结束后回答；普通阻塞提问与审批仍校验当前轮次。已完成请求不展示，已移除请求返回 `stale-request`。本机倒计时准确截止时间未通过 follower IPC 同步，控制端不模拟默认操作。

### 图片

图片接口使用同账号登录会话认证。凭据不能放在图片 URL。浏览器以带认证的 `fetch` 获取二进制，再使用内存 Blob URL 展示；断开登录时清理 Blob 和草稿。Web 支持选择、粘贴和拖放，上传中或失败的附件会禁用发送，成功确认前保留草稿。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/devices/:deviceId/threads/:threadId/images` | body 为 `{name,mimeType,base64}`，返回 `{id,name}` |
| GET | `/v1/devices/:deviceId/threads/:threadId/images/:imageId` | 返回图片二进制，`Cache-Control:no-store`，需要同账号会话认证 |
| GET | `/v1/agent/:deviceId/threads/:threadId/images/:imageId` | 只接受该设备 Bearer 凭据，返回待发送图片 JSON，供 Agent 下载 |

支持 PNG、JPEG、WebP、GIF，单张最多 4 MiB，每条命令最多 4 张。服务校验标准 Base64、文件头和声明的 MIME，一台设备 Relay 图片存储预算为 128 MiB，超出返回 `image-storage-full`。上传需要 thread 属于设备目录；ID 按设备、会话及内容生成，不接受路径或外部 URL。

`turn.start.images?:string[]` 和 `turn.queue.images?:string[]` 为上传返回的 64 字符 ID 数组。`text` 允许为空，但文本和图片不能同时为空。Relay 检查图片属于同一设备/会话。Agent 使用设备认证下载，将图片保存在自身数据目录 `images/`，向两种官方运行时提交 `localImage` 输入，不改变会话模型或权限。队列消息保存于 Agent 的 `commands.sqlite`，重启后继续显示；发送中断且无法确认结果时不会自动重试。

规范化 item 的可选 `images` 为最多 8 项的 `{id,name,source?}`，不含图片字节。`source` 仅用于替换回复 Markdown 中已经观察到的本机图片引用，不能用来请求任意文件。Agent 只为官方消息的图片输入、`imageView`、`imageGeneration` 以及 assistant Markdown 图片建立不透明 ID；远程请求只提供 ID。不会在后台下载任意 HTTP URL。只接受有图片文件头、大小合规的本机文件。

缓存未命中时 Relay 通过 `image.request` 请求 Agent，并核对设备、thread、图片 ID 和 request ID 后接收 `device.image`。最多 12 个并发请求、一台设备最多 4 个，超时 15 秒；断线、撤销和连接替换会立即失败。图片字节不进入快照、目录、事件或命令结果；单次独立图片响应仍受 8 MiB 传输预算限制。

实时和历史 turn 可带 `tokenUsage`：

```json
{
  "totalTokens": 950,
  "inputTokens": 900,
  "outputTokens": 50,
  "cachedInputTokens": 700,
  "cacheWriteInputTokens": 0,
  "reasoningOutputTokens": 20,
  "state": "complete",
  "model": "configured-model-at-turn-start"
}
```

`cacheWriteInputTokens`、`reasoningOutputTokens` 和 `model` 可省略。缓存命中是输入的子集，推理输出是输出的子集，不能重复加进总计。`model` 是观察到的轮次开始配置，不保证等于服务提供方最终路由模型。

`state:running` 表示从开始持续观察、尚未结束；`complete` 表示完整观察该轮；`partial` 表示中途接入、断线、重启或累计计数重置，只展示已可靠关联的用量。没有该字段表示未记录，不能解释成 0。

Agent 在自身 SQLite `usage.sqlite` 中按 `threadId + turnId` 保存逐轮统计，实时与分页历史关联同一记录。桌面流按连续累计 `total` 的差值统计，在 400 ms 远程事件合并前处理；独立 app-server 直接接收携带 `turnId` 的 `thread/tokenUsage/updated`。首次 follower 快照只建立基线，重复累计值不计数。`thread.tokenUsage` 继续保留官方原始 `{total,last,...}` 以兼容旧版：其中 `last` 是最后一次模型调用，不能作为整轮 Token。

加入统计后再次应用实时快照和历史页面的原大小预算；超限时保留统计字段并截断内容项，设置相应的截断标记，不修改适配器原始数据。

官方历史 turn 接口没有逐轮用量，已有旧 JSONL 也可能停止更新，所以当前不从旧日志推算历史用量。未被 Agent 记录的历史轮次显示“Token 未记录”；保存的完整记录在服务重启后仍可读取，未完成记录变为 `partial`。这些数值来自运行时报告，不是账单或费用估算。

## 浏览器 WebSocket

连接 `/v1/ws/client` 后发送：

```json
{"type":"client.authenticate","ticket":"one-use-ticket"}
```

收到 `client.authenticated` 后订阅设备：

```json
{"type":"client.subscribe","deviceId":"device-id","epoch":"known-epoch","lastSeq":42}
```

首次订阅省略 `epoch`、`lastSeq`。服务端依次发送 `sync.begin`、`device.snapshot` 或若干 `device.event`、`sync.ready`、`device.presence`。之后推送实时事件和 `command.result`。断线需重新申请 ticket；只有持有完整快照时才发送游标。reducer 发现序列错误就不带游标重订阅。设备 `online` 由 presence 消息决定，缓存快照不能证明 PC 仍在线。

## 命令

命令可通过 REST 或已认证 WebSocket 的 `{type:"client.command",command}` 发送。字段：

```json
{
  "commandId": "unique-client-uuid",
  "deviceId": "paired-device-id",
  "expectedEpoch": "current-snapshot-epoch",
  "expiresAt": 1780000000000,
  "payload": { "type": "turn.start", "threadId": "observed-chat-id", "text": "你好" }
}
```

`expiresAt` 必须晚于当前时间且不超过 5 分钟。支持以下 payload：

| type | 必需字段 | 条件 |
| --- | --- | --- |
| `thread.watch` | `threadId` | 会话必须在设备目录中；按需接入实时状态 |
| `turn.start` | `threadId,text`，可选 `images` | 观察到会话 `idle`、owner 可用；文本或图片至少一项非空 |
| `turn.queue` | `threadId,text`，可选 `images` | 会话 `active`；每会话最多 20 条，空闲后自动发送下一条 |
| `turn.queue.steer` | `threadId,turnId,queueId` | 队列项仍待发送且活动 turn ID 匹配；立即引导当前轮 |
| `turn.queue.remove` | `threadId,queueId` | 删除仍待发送或结果未确认的队列项 |
| `thread.model.update` | `threadId,model,expectedModel` | 会话 `idle`、owner 可用，当前模型匹配 `expectedModel`；模型名称至多 200 字符，不含空白或控制字符 |
| `thread.effort.update` | `threadId,effort,expectedModel,expectedEffort` | 会话 `idle`，当前模型和档位匹配，目标档位在支持列表中 |
| `thread.mode.update` | `threadId,mode,expectedMode,expectedModel,expectedEffort` | 会话 `idle`，模型/档位/模式匹配；目标模式为 `default` 或 `plan` |
| `turn.interrupt` | `threadId,turnId` | 当前活动 turn ID 完全匹配 |
| `approval.respond` | `threadId,turnId,requestId,decision` | `decision` 为 `accept`、`decline` 或 `cancel` 且该请求允许 |
| `input.respond` | `threadId,turnId,requestId,answers` | RPC 覆盖当前每个问题 ID；消息提问支持待回答 ID 的非空子集；值形如 `{answers:["选项"]}` |

`input.respond` 同时处理 RPC 提问及消息中的异步提问。消息提问的 `requestId` 以 `async:` 开头，`details.source` 为 `asyncMessage`，问题 ID 为原始下标字符串；客户端使用收到的 ID 原样提交。Agent 校验仍有效的来源轮次及提交的问题 ID，再用官方结构化回答引导当前轮次；消息提问按题回传，RPC 仍需要完整问题集。消息提问在来源轮次完成后失效；RPC 非阻塞请求可在原始轮次结束后继续回答。详见 [会话交互](conversation.md)。

初始响应可能是 `{type:"command.accepted",commandId}`，终态是 `{type:"command.result",result:{commandId,deviceId,status,code}}`。`status` 是 `succeeded`、`failed` 或 `unknown`。`succeeded` 仅表示本机运行时确认操作，模型回复需继续观察事件。结果可以通过命令查询接口恢复。原命令内容不变时可用相同 `commandId` 重试传输；`unknown` 不应自动换 ID 重发。

## 静态页面

Relay 启动时若 `RELAY_WEB_DIR` 存在，在根路径提供 Web UI。Web/App 用账号密码登录；网页在当前站点 localStorage 中保存会话，App 使用系统安全存储。前台续期、回到前台重连，短暂网络故障保留会话；过期或被撤销后重新登录。各账号进入同账号 PC Agent 列表与会话，管理员另有独立账号管理入口。

管理后台与远程控制端使用独立入口：`/admin` 只做账号管理；`/` 和 App 只做同账号 PC Agent 的选择与远程控制，不提供账号管理菜单。两个网页入口分别保存登录状态，后台不加载 PC 列表、会话或控制 WebSocket。

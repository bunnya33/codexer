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
| GET | `/v1/devices/:deviceId/threads/:threadId/weixin-notification` | 当前账号的会话偏好 `{enabled,allEnabled,available,bound}`，缺省 `enabled:false` |
| PUT | `/v1/devices/:deviceId/threads/:threadId/weixin-notification` | 保存 `{enabled:boolean}`；校验设备/会话归属并向本账号在线客户端同步 |
| DELETE | `/v1/weixin` | 解除当前账号绑定并清除对应收发队列 |
| POST | `/v1/weixin/test` | 激活后提交测试通知，`queued:true` 表示入队，不代表已投递 |

二维码绑定冲突返回 409 `weixin-bot-already-bound`；其他账号的绑定流程返回 404 `weixin-login-not-found`；未激活测试返回 409 `weixin-not-activated`。微信功能未开启时 GET 返回 `available:false`，其他操作返回 503 `weixin-disabled`。上游错误使用脱敏的固定错误代码。

`notifications:true` 表示通知全部已监听会话；关闭后只通知单独开启的会话。会话偏好可在绑定微信前保存，按账号、设备和会话持久化，不随退出或登录设备改变。修改后控制 WebSocket 发送 `weixin.thread-notification`（`deviceId,threadId,notification`）或 `weixin.settings`（`status`），只发给当前账号。新登录或重连用 REST 校准。关闭总开关会保留单独开启会话的待发送完成通知；关闭单个会话且总开关关闭时移除该会话的待发送完成通知。已发起的微信发送无法撤回。

## 用户文件附件上传

以下控制端接口要求普通账号 Bearer 会话，校验设备归属与当前会话目录。附件 ID 为服务器生成的 64 位十六进制随机值，与图片 ID 独立。

| 方法 | 路径 | 请求与响应 |
| --- | --- | --- |
| POST | `/v1/devices/:deviceId/threads/:threadId/attachments` | `{name,size,mimeType}` 预留暂存空间，返回 `{id}` |
| PUT | `/v1/devices/:deviceId/threads/:threadId/attachments/:id` | `{offset,base64}` 顺序上传最多 512 KiB 原始数据；返回 `{offset,attachment?}`，最后一块包含 `{id,name,size,mimeType,sha256}` |
| DELETE | `/v1/devices/:deviceId/threads/:threadId/attachments/:id` | 删除未发送/放弃的暂存文件，返回 `{ok:true}` |
| GET | `/v1/agent/:deviceId/threads/:threadId/attachments/:id?info=1` | 仅目标设备 Agent 会话可读，返回已完成附件的元数据；去掉 `info=1` 流式下载 |

单个文件最多 20 MiB，暂存 24 小时；预留每设备 256 MiB、全局 1 GiB，最多 2000 份。零字节文件提交空块完成流程。大小或文件名非法返回 400 `invalid-attachment`；块非法为 400 `invalid-attachment-chunk`，偏移不符为 409 `attachment-offset-mismatch`；配额不足为 413 `attachment-storage-full`，未完成/过期/跨会话为 404 `attachment-unavailable`。旧 Agent 返回 409 `agent-update-required`。

支持附件的 Relay 在 `device.welcome.features` 广播 `attachments`，新 Agent 协商后在快照公布 `runtime.capabilities.attachments:true`。`turn.start`、`turn.queue`、`turn.steer` 可带 `attachments:string[]`（最多 4 个 ID）；文字、图片、文件至少有一项。队列摘要可带 `fileCount`，完整队列读取保留 `attachments`。Agent 下载时校验大小与 SHA-256，并用官方文本输入中的本地文件引用交给 Codex。排队时即持久化本机副本，编辑正文不改附件。

## 会话文件读取

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/devices/:deviceId/threads/:threadId/files/info?path=...` | 返回 `{name,size,version}`；只读取元数据，不读取内容 |
| GET | `/v1/devices/:deviceId/threads/:threadId/files/content?path=...&version=...` | 经 PC Agent 分块读取并流式返回二进制附件 |
| POST | `/v1/devices/:deviceId/threads/:threadId/files/audio` | `{path,version}`：验证已引用音频并返回临时 `{path,expiresAt}` 播放地址 |
| GET/HEAD | `/v1/audio/:token` | 绑定登录会话的音频；支持单个字节 Range、206/416、元数据检查，按需回源、不保存内容 |
| DELETE | `/v1/audio/:token` | 原登录会话撤销播放地址并停止进行中的读取 |

文件信息、下载以及创建/撤销音频地址需要同账号 Bearer 认证；播放器通过临时 token 读取音频，无需把登录凭据放进 URL。token 只允许读取绑定的文件，30 分钟后失效，关闭播放器或原登录会话失效时撤销，应作为临时访问凭据保管。`path` 为 URL 编码后的 PC 绝对路径；只接受当前会话官方消息里实际观察到的 Markdown 文件链接。支持 Windows/Unix 路径、中文与空格，以及本地 `file:` 链接，不接受网络共享路径。PC 必须在线，服务器与 PC 连接器都需更新到支持文件协议的版本。旧连接器返回 409 `agent-update-required`；文件未引用/不可读返回 404 `file-not-in-thread|file-unavailable`；文件变化返回 409 `file-changed`，应重新获取元数据。

文件上限 512 MiB，Agent 每块最多 256 KiB，并校验文件版本和读取偏移。Relay 最多同时转发四个内容传输、每设备两个；超出返回 429 `files-busy`。每块回源等待最多 15 秒，返回 504 `file-timeout`。客户端断开会取消待回源请求；设备离线和服务器关闭会及时失败。**Relay 不缓存、不写入磁盘或数据库，也不把文件字节放入快照或历史。** 内容响应为附件、`no-store`、`nosniff`，浏览器不能在服务器来源下执行文件。传输中变化或断线会终止响应，客户端检查完整长度。

客户端自动阅读不超过 2 MiB 的 UTF-8 MD/TXT/JSON 及常见文本文件；JSON 自动格式化。PNG/JPEG/WebP/GIF/BMP/ICO/AVIF/SVG 文件直接弹窗预览，不受文本预览限制，仍受文件传输上限约束。Web 使用带认证的 fetch 和内存 Blob URL，按扩展名设置图片 MIME，并核对传输长度；SVG 只在 img 中显示。原生栅格图片使用带认证的图片源，SVG 获取后在客户端渲染。图片不使用 Relay 图片缓存，也不新增文件存储；解码失败时显示错误并保留下载按钮。其它格式、较大文本和无法按 UTF-8 解码的文件显示下载确认，再请求内容。网页交给浏览器下载，原生端用临时文件交给系统保存/分享并清理临时文件；PC 源文件保留。

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
| GET | `/v1/admin/metrics` | 管理员聚合性能指标：进程资源、排队、数据库、HTTP、事件、广播和清理；`Cache-Control: no-store`，见 [指标说明](relay-metrics.md) |
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

目录的可选 `models` 来自官方分页 `model/list`，每项是 `{model,displayName,supportedReasoningEfforts,defaultReasoningEffort}`，至多 200 项，不含隐藏模型。模型查询失败时省略该字段，项目和会话列表仍可用。选择器保留当前模型及目录中的模型；自定义 API 提供方的真实可用性由该提供方处理请求时决定。

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
| `turn.queue.read` | `threadId,queueId` | 读取未发送项的完整 `{queueId,text,images}`，拒绝已开始发送的项 |
| `turn.queue.update` | `threadId,queueId,text,expectedText` | 正文及预期正文各至多 32000 字符；保留图片，预期正文必须匹配；与自动发送串行执行 |
| `thread.model.update` | `threadId,model,expectedModel` | 会话 `idle`、owner 可用，当前模型匹配 `expectedModel`；模型名称至多 200 字符，不含空白或控制字符 |
| `thread.effort.update` | `threadId,effort,expectedModel,expectedEffort` | 会话 `idle`，当前模型和档位匹配，目标档位在支持列表中 |
| `thread.mode.update` | `threadId,mode,expectedMode,expectedModel,expectedEffort` | 会话 `idle`，模型/档位/模式匹配；目标模式为 `default` 或 `plan` |
| `turn.interrupt` | `threadId,turnId` | 当前活动 turn ID 完全匹配 |
| `approval.respond` | `threadId,turnId,requestId,decision` | `decision` 为 `accept`、`decline` 或 `cancel` 且该请求允许 |
| `input.respond` | `threadId,turnId,requestId,answers` | RPC 覆盖当前每个问题 ID；消息提问支持待回答 ID 的非空子集；值形如 `{answers:["选项"]}` |

`input.respond` 同时处理 RPC 提问及消息中的异步提问。消息提问的 `requestId` 以 `async:` 开头，`details.source` 为 `asyncMessage`，问题 ID 为原始下标字符串；客户端使用收到的 ID 原样提交。Agent 校验仍有效的来源轮次及提交的问题 ID，再用官方结构化回答引导当前轮次；消息提问按题回传，RPC 仍需要完整问题集。消息提问在来源轮次完成后失效；RPC 非阻塞请求可在原始轮次结束后继续回答。详见 [会话交互](conversation.md)。

初始响应可能是 `{type:"command.accepted",commandId}`，终态是 `{type:"command.result",result:{commandId,deviceId,status,code}}`。`status` 是 `succeeded`、`failed` 或 `unknown`。`succeeded` 仅表示本机运行时确认操作，模型回复需继续观察事件。结果可以通过命令查询接口恢复。原命令内容不变时可用相同 `commandId` 重试传输；`unknown` 不应自动换 ID 重发。

命令结果的 `result` 对象上限为 256 KiB，以容纳含 JSON 转义的完整排队正文；请求 `details` 保持 16 KiB。编辑使用 `expectedText` 检查并发修改，不匹配返回 `queue-item-changed`；已发送、已移除或发送中的项返回 `queue-item-unavailable`。

## PC Agent 安装包分发（服务器 0.3.19）

| 方法与路径 | 权限与行为 |
| --- | --- |
| `GET /v1/admin/pc-agent/release` | 管理员查询当前安装包，返回 `{release:null}` 或 `{release:{id,name,version,size,sha256,uploadedAt}}` |
| `PUT /v1/admin/pc-agent/release?name=...&version=...` | 管理员上传原始 EXE 字节，`Content-Type: application/octet-stream`；完成校验和原子发布后返回 `{release}` |
| `GET /v1/pc-agent/release` | 普通控制端账号查询当前安装包，同上 |
| `GET /v1/pc-agent/releases/{id}/download` | 普通控制端账号下载；支持 HEAD、单个 Range，附件、no-store、原始文件名、SHA-256 ETag |

上传限制 256 MiB、10 分钟，每次仅允许一个上传。文件名必须为安全的 `.exe` 名称，版本格式如 `0.2.6`；校验 Windows PE 可执行文件结构，拒绝 DLL。上传暂存于私有临时文件，成功后原子切换持久化元数据，失败/中断保留旧包；发布前重新校验管理员登录。文件保存在 `RELAY_DATA_DIR/agent-releases`，与数据库和服务器安装目录分开。以最后一次成功发布为最新版，不执行上传的文件；服务器重启后继续提供同一包。

下载仅接受当前发布 ID。读取元数据后若管理员替换了安装包，旧 ID 返回 404 `agent-release-unavailable`，刷新后重试；已开始下载的文件不混入新版字节。常见错误：400 `invalid-agent-release|invalid-agent-executable|agent-upload-incomplete`、413 `agent-installer-too-large`、409 `agent-upload-in-progress`、500 `agent-release-storage-error`。反向代理需允许对应上传体积和超时。接口均要求 Bearer 认证，管理员不通过普通控制端下载接口访问设备数据。

## 公开网页与音频分享（服务器 0.3.21）

所有管理接口都要求普通账号登录并拥有目标设备：

| 方法与路径 | 行为 |
| --- | --- |
| `GET /v1/devices/{deviceId}/threads/{threadId}/preview-shares?kind=server&source=...` | 查询现有分享，返回 `{share:null}` 或 `{share:{id,path,enabled,kind,expiresAt,durationMinutes}}`，不会自动创建 |
| `POST /v1/devices/{deviceId}/threads/{threadId}/preview-shares` | 请求 `{kind,source,rotate?:boolean,durationMinutes?:number}`，创建、重新开启或更新有效期；返回 `{id,path,enabled,kind,expiresAt,durationMinutes}` |
| `DELETE /v1/devices/{deviceId}/preview-shares/{shareId}` | 停用分享，立即撤销该分享的访问和进行中的连接 |
| `GET /share/{key}` | 无需登录的访客页面，隔离加载所分享的内容 |
| `GET/HEAD /share/{key}/audio` | 仅限音频分享，读取绑定的单个音频；支持单段字节 Range、206/416、HEAD 与分块转发 |

`kind` 为 `server`、`html` 或 `audio`。服务来源仅接受 Agent 已在会话中观察到的 loopback HTTP(S) 地址；同一设备、种类和来源复用固定 key，忽略 fragment、统一 localhost/127.0.0.1 与默认端口，保留页面路径和查询参数。服务分享允许该端口的资源、接口和 WebSocket，不是单个 URL 的路径隔离。HTML 来源必须是该会话引用过的 UTF-8 HTML/HTM 文件，最多 2 MiB，按需读取当前版本，不开放相邻文件。

音频 `source` 为已引用音频的 PC 路径，扩展名与实际文件名均需为支持的音频格式。访客页面只包含可信播放器和转义后的文件名，不暴露 PC 路径或登录凭据。每次媒体请求读取当前源文件的元数据，并在该响应内绑定版本；文件中途变化会终止传输。URL 查询参数不能改换来源，不开放相邻文件，不创建私有 `/v1/audio` 登录播放地址，也不保存音频内容。与下载共用全局 4 个/设备 2 个持续传输限额；播放器实际编码支持取决于访客浏览器。停用或到期中断进行中的回源并拒绝后续请求，不能收回访客已取得的字节。

`durationMinutes` 默认为 30，必须是 1–525600 的整数（1 分钟至 365 天）。界面提供 30 分钟、1 天、自定义分钟/小时/天。每次显式 POST 从成功保存时开始计时，返回 Unix 毫秒 `expiresAt` 和所选 `durationMinutes`；GET、复制链接和访客访问不延长有效期。`enabled` 为当前可用状态，到期为 false；到期外部请求返回 410，HTTP/SSE/WebSocket 进行中转发也会被撤销。延长有效期保留现有访客连接，收短会按新期限撤销。

公开 key 和到期时间保存在数据库，不随创建者退出登录、关闭预览或 Relay 重启改变。升级前无期限的链接按原创建时间加 30 分钟补齐截止时间，已超时的链接需显式重新开启。每位访客使用独立临时预览和 Cookie 容器；临时预览最多 24 小时，在分享有效期内，临时预览过期后重新打开固定链接即可。重新开启沿用旧 key；`rotate:true` 换 key 并立即撤销旧访问。设备及账号必须仍有效，源会话仍在设备目录中，PC 在线且 Agent 保留该来源的读取权限；端口停止或 PC 离线时不可用，有效期内恢复后可重新加载原链接。每账号最多 100 个分享记录、100 个活跃访客预览，全服务器最多 1000 个预览。

## 静态页面

Relay 启动时若 `RELAY_WEB_DIR` 存在，在根路径提供 Web UI。Web/App 用账号密码登录；网页在当前站点 localStorage 中保存会话，App 使用系统安全存储。前台续期、回到前台重连，短暂网络故障保留会话；过期或被撤销后重新登录。各账号进入同账号 PC Agent 列表与会话，管理员另有独立账号管理入口。

管理后台与远程控制端使用独立入口：`/admin` 只做账号管理；`/` 和 App 只做同账号 PC Agent 的选择与远程控制，不提供账号管理菜单。两个网页入口分别保存登录状态，后台不加载 PC 列表、会话或控制 WebSocket。

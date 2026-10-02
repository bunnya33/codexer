# Remote Protocol v1

Schemas and exported TypeScript types are in `packages/protocol/src/index.ts`. The Relay exposes this protocol, never raw Codex JSON-RPC.

## REST

All authenticated endpoints use the session returned by account login. Health and the two login endpoints are public; administrator privileges only apply to account management; PC access always checks account ownership.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Process health and protocol version |
| GET | `/v1/devices` | Owner's unrevoked devices and live presence |
| DELETE | `/v1/devices/:deviceId` | Revoke credential and close the Agent socket |
| GET | `/v1/devices/:deviceId/snapshot` | Cached snapshot plus independently measured presence |
| GET | `/v1/devices/:deviceId/catalog` | Complete saved project and interactive chat catalog |
| GET | `/v1/devices/:deviceId/threads/:threadId/turns?cursor=...` | On-demand older history from the PC, five turns per page |
| POST | `/v1/ws/tickets` | Issue a one-use client ticket, expires in 60 seconds |
| POST | `/v1/devices/:deviceId/commands` | Submit a validated remote command |
| GET | `/v1/devices/:deviceId/commands/:commandId` | Query a durable result |

All endpoints use account login. POST /v1/auth/login accepts username/password; POST /v1/agents/login also registers the PC installation under that account and returns its scoped session. Client sessions follow the configurable idle timeout; PC sessions expire after 7 days. Password reset and account disable revoke client and PC sessions. Admin privileges only apply to account management. See api.md for the current route table.

## Device WebSocket

Connect to `/v1/ws/device` with the PC account login session in `Authorization` and `X-Device-Id`. Credentials never go in a URL.

Relay sends `device.welcome` with optional `features:["catalog","history"]`. The Agent sends `device.snapshot` on connection and on `device.resync`. Then it sends ordered `device.event` envelopes. Each event includes `protocolVersion`, `deviceId`, `epoch`, `seq`, `timestamp`, and `change`.

Catalog support is an additive v1 feature: an Agent only sends `device.catalog` after the Relay advertises `catalog`. This avoids sending an unknown message to an older Relay. The catalog is validated and persisted separately from snapshot/event sequence, with up to 1000 projects, 10000 interactive chats and 6 MiB. It is not silently limited to the 20 live previews. See [api.md](api.md) for membership and archive rules.

For history, the Relay sends `{type:"history.request",requestId,threadId,cursor}`. The Agent replies `{type:"device.history",requestId,threadId,page,code}`; success has a normalized history page and `code:null`, failure has `page:null`. The reply is bound to the current device connection and pending request, then returned to the requesting REST caller. History is read without resuming a writer and is not stored as an event or command result. Requests are rejected immediately on disconnect, revocation or connection replacement.

Changes are `thread.updated`, `thread.removed`, and `runtime.status`. They contain normalized bounded state rather than application-specific patches. The Agent coalesces thread updates over 400 ms; the resulting stream is ordered, but is not a replay of every token/terminal byte.

`snapshot.runtime.kind` is `official-desktop-ipc` or `official-app-server`. A `runtime.status` change may include `kind` when the Agent switches between them. Clients should keep a chat's controls disabled when `ownerAvailable` is false, even if the device itself is online.

Relay sends `{type:"command", command}`. Agent responds `{type:"command.result", result}`. A newer connection fences and closes the older one.

## Client WebSocket

1. Fetch `/v1/ws/tickets` over authenticated HTTPS.
2. Connect `/v1/ws/client`.
3. Send `{type:"client.authenticate", ticket}` within 5 seconds.
4. Wait for `client.authenticated`.
5. Send `{type:"client.subscribe", deviceId, epoch?, lastSeq?}`.

The Relay serializes replay and live delivery and responds:

```text
sync.begin (mode = snapshot or replay)
device.snapshot OR zero or more device.event messages
sync.ready
device.presence
live device.event messages
catalog.updated (fetch the catalog REST endpoint again)
```

Store each device's snapshot together with its epoch and last sequence. Apply each event through `reduceEvent`. A gap, duplicate, or epoch mismatch must trigger a new subscribe without a cursor. Cache presence separately: a cached active turn is not proof that the PC is online. An unavailable thread or non-respondable request must disable the corresponding controls.

Events are retained for 24 hours; replay is limited to 1000 contiguous events. Missing events, retention expiry, or an Agent restart result in a snapshot fallback.

## Commands

```json
{
  "commandId": "client-generated-unique-id",
  "deviceId": "paired-device-id",
  "expectedEpoch": "current-agent-epoch",
  "expiresAt": 1780000000000,
  "payload": {
    "type": "turn.interrupt",
    "threadId": "desktop-chat-id",
    "turnId": "observed-active-turn-id"
  }
}
```

Use a real expiry within the next 5 minutes. Other payloads:

- `turn.start`: `threadId`, `text`; only permitted for an observed idle chat.
- `thread.watch`: `threadId`; attaches a selected catalog chat to live observation, using the local app-server when desktop IPC has no owner.
- `turn.queue`: `threadId`, `text`, optional `images`; stores a follow-up during an active turn. The Agent starts it when the chat becomes idle.
- `turn.queue.steer`: `threadId`, `turnId`, `queueId`; sends a queued message into the matching active turn through the official steer method.
- `turn.queue.remove`: `threadId`, `queueId`; removes a queued or unconfirmed message.
- `thread.model.update`: `threadId`, `model`, `expectedModel`; requires an observed idle chat and a matching current model. Capability is advertised as `runtime.capabilities.modelUpdate`.
- `thread.effort.update`: `threadId`, `effort`, `expectedModel`, `expectedEffort`; requires supported effort and matching idle-chat settings. Capability is `runtime.capabilities.effortUpdate`.
- `thread.mode.update`: `threadId`, `mode` (`default`/`plan`), `expectedMode` (nullable), `expectedModel`, `expectedEffort`; idle chat only. Capability is `runtime.capabilities.collaborationModeUpdate`; thread settings expose optional nullable `collaborationMode`.
- `approval.respond`: `threadId`, `turnId`, `requestId`, `decision` (`accept`, `decline`, `cancel`).
- `input.respond`: `threadId`, `turnId`, `requestId`, `answers` mapping every current question ID to `{answers:["value"]}`.

User-input RPC requests preserve `questions`, `isBlocking` and deprecated `autoResolutionMs` in bounded details. A still-pending nonblocking RPC request (`isBlocking:false`) may be answered after its originating turn; blocking input and approvals require the current turn. Request ID, originating turn and exact question IDs must match. Completed/removed requests are not answerable.

Desktop async questions can instead arrive as `agentMessage.questions` with `{title,options}` entries. The Agent synthesizes `userInput` requests with an `async:` ID, `details.source:"asyncMessage"`, `sourceItemId`, index-based question IDs and `isBlocking:false`. These requests are valid only while their source turn is in progress. Accepted structured replies remove answered questions; pending/rejected steering does not. The Agent reconstructs the official `["request_user_input_async",sourceItemId,index]` identities and sends the official reply envelope through turn steering. Clients still submit `input.respond`; they never forge the official message text. Items optionally expose `questionRequestId` so clients can suppress duplicate prose while the card is present. User-visible reply text decodes the internal envelope while preserving additional user text.

This IPC does not provide the desktop auto-resolution deadline; clients must not derive a countdown from the deprecated duration. See [conversation interaction](conversation.md).

Send with REST or `{type:"client.command",command}` over an authenticated client socket. Initial response is `command.accepted`; terminal response is `command.result`. The latter has status `succeeded`, `failed`, or `unknown`, and a bounded diagnostic code. Results are broadcast to clients subscribed to that device.

Retry transport with the **same command ID, epoch, expiry and payload**. Changed data under the same ID is rejected. Do not create a new ID to retry an unknown outcome. The Agent writes a pending journal entry before dispatch and never blindly executes it again after a crash. The Relay likewise marks pending outcomes unknown after restart or timeout. IDs/results are retained to preserve deduplication.

`succeeded` means the selected Codex runtime acknowledged the operation, not that a model turn completed. Use stream updates to track execution. `stale-turn`, `stale-request`, `stale-device-epoch`, `decision-not-available` and `thread-not-idle` are normal conflicts that need fresh state and user intent.

## Deployment Constraints

Images are additive v1 fields, advertised as `runtime.capabilities.images`. `turn.start` and `turn.queue` accept up to four uploaded IDs in `images`; text may be empty only when an image is present. Item `images` contains scoped opaque references, never bytes. Agent downloads uploads using its device credential, writes its own persistent image files, and passes `localImage` inputs to the official runtime. On-demand viewing uses authenticated REST plus correlated `image.request` / `device.image` messages. Image responses are not broadcast or persisted as events. See [api.md](api.md) for limits, ownership checks and retention.

Optional turn `fileChanges` summarizes successful recorded file edits and bounded diffs. Completed-turn rendering collapses process items while preserving the original positions of steering messages and final answers. Older clients can ignore the optional fields. Web hides archived chats and exposes no archive toggle.

Model settings/options and per-turn usage are optional additive v1 fields. Thread `settings` contains the configured model, provider and reasoning effort; the catalog optionally includes `models`. Turn `tokenUsage` contains normalized input/output/cache counters and `state:running|complete|partial`, recorded by the Agent before event coalescing and persisted in its own SQLite store. Missing historical records are omitted. The legacy thread-level raw `tokenUsage.last` is a single model call, never a whole-turn counter. See [api.md](api.md) for schemas and coverage rules.

Remote HTTP requires explicit opt-in; production deployments should use TLS. Devices, commands and client sessions are scoped to their owning account. Browser origins are explicitly allowlisted. Payloads are cached in the Relay database without end-to-end encryption. HTTP requests and client messages are rate limited; snapshots/messages and outgoing socket buffers are bounded. Logs contain metadata, not payloads. Run a single Relay instance until distributed routing/ownership is implemented.

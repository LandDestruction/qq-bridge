# QQ Identity Fail-Closed Guard

## Scope

This patch prevents bridge-controlled outbound QQ operations unless the authenticated account is the configured, fixed bot identity (the fixed `REQUIRED_BOT_SELF_ID` in `src/safety/identity-lock.js`). Unknown identity, empty/misconfigured allowlist, stale/mismatched login, timeout, invalid endpoint, or malformed response all block the operation. `warn` mode is not permission to send. For privacy, this document omits the literal UIN; the source constant is the authorization reference.

The bridge now constructs the SnowLuma client with SDK reconnect disabled and gates explicit connects with the same fixed-identity checks. A post-open verification still closes a socket whose WS login is not the fixed bot. The source fix is not active in any running bridge until an authorized restart; do not describe the running service as protected yet.

## Enforcement points

- `src/safety/identity-send.js` refreshes identity immediately before SDK mutations and HTTP OneBot writes. HTTP checks query `/get_login_info` on the same local OneBot root endpoint used for the pending HTTP send; remote URLs, redirects, cache hits, invalid envelopes, timeout, and wrong identity fail closed.
- `src/bridge/boot/qq-gateway.js` wraps the live SDK client. Text/private send methods, poke/raw writes, friend approvals, custom-face mutations, and unknown SDK methods require the guard. Explicit read-only SDK methods/actions are allowlisted. Direct socket access is hidden through the proxy.
- `src/bridge/outbound-text.js`, `src/bridge/media-send.js`, `src/bridge/voice.js`, `src/private-temp-session.js`, and `src/bridge/login-recovery.js` refresh the HTTP identity after queuing/pacing and before the write.
- `src/mcp-snowluma-safe/http.js` restricts its generic OneBot helper to named read-only actions.
- `scripts/send-voice.mjs` no longer has a direct OneBot send path. `scripts/send-test-group.mjs` uses only the local bridge API, requires explicit target/message, defaults to dry-run, and requires `--confirm` for an actual send. Never run its confirmed path as a test.

## Verification

- `node scripts/test-identity-lock.mjs` — 21/21 passed. Includes fixed-identity allow, unknown/mismatch/warn/empty-list deny, SDK mutator/raw/request deny, read-only allow, delayed HTTP send recheck, same-endpoint HTTP validation, friend-approval guard ordering, connect pre/post hooks, token-healing denial, local WebSocket mapping, and MCP read-action allowlist.
- `node scripts/test-audit-bridge.mjs` — 14/14 passed, including sticker byte-source checks and voice allowlist/budget/path confinement.
- `node --check` passed for the changed identity, bridge, CLI, and test JavaScript files in the final focused run.
- No QQ probe or test message was sent. No SnowLuma, QQ, watchdog, or bridge service was restarted/stopped during final verification.

## Runtime and incident boundary

**Activated 2026-11-12 (Asia/Shanghai)** after the owner confirmed the bot account was logged in and authorized a bridge restart. Only the bridge process was restarted; SnowLuma and QQ were left untouched and no test message was sent.

First start of the patched bridge exposed a wiring defect: `watchConnection()` in `src/bridge.js` was not given `verifyConnectedIdentity`, so every post-open check threw `deps.verifyConnectedIdentity is not a function`, closed with code 4003 and reconnected in a loop. That is fail-closed behaviour (nothing was sent), but it also meant the bridge was offline. The binding was added to the `watchConnection` dependency object; `node --check src/bridge.js` passed and the bridge was restarted.

Observed after the fix: `SnowLuma 已连接：ws://127.0.0.1:3001`, `机器人昵称: 大肥鱼小姐`, and `GET /api/status` reported `identityLock={enabled:true, ready:true, ok:true, lock:false, mode:"lock"}` with `selfId` equal to `expected` (both the fixed bot UIN). No `[安全]` denial and no disconnect loop appeared in the log afterwards.

The dedicated task `QQDeepSeekBot-Bridge-Guard` remains **disabled** (last read-only check: `TaskState=Disabled`, `TaskEnabled=False`), so nothing will auto-restart the bridge if it exits. Re-enabling it is a separate decision.

Historical logs include outbound-success messages while the identity state was reporting a mismatch. Those logs do not identify the sender UIN; without QQ-side message records, whether the personal account actually delivered those messages remains unproven.

## Remaining checks

- After the owner confirms the intended account is currently logged in and explicitly authorizes restart, restart the bridge, then read status/logs to verify the observed login matches the fixed bot identity and that mismatch remains blocked. Do not send a test message for this verification.
- Re-run `node scripts/regression-all.mjs`. Prior run was 182/207; failures included the existing `createCappedLogger` marker mismatch in the source-extraction harness and an existing size violation in user-modified `src/bridge/media-input.js` (303 lines in one function). Do not change that unrelated file as part of identity safety.
- Do not edit or clean existing user changes/untracked assets.

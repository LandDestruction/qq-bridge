// 一键回归：跑一批**不需要活 DSH**的套件，汇总 pass/fail。
//
// 用法：node scripts/regression-all.mjs        # 默认套件
//       node scripts/regression-all.mjs --all  # 除已知需要环境外的全部 test-*.mjs
//
// 为什么需要：今天累计 9 个提交，审阅窗口手工逐个跑容易漏；这条命令给出单一结论行。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
// 这些套件需要活的 DSH 控制 socket 或真实模型凭据，CI/本地都跑不了 —— 显式跳过并说明原因。
const NEEDS_ENV = {
  'test-dsh-session-retire.mjs': '需要活 DSH 控制 socket',
  'test-dsh-endpoint.mjs': '可降级运行：无 DSH 时大部分用例跳过（仍跑）',
  'test-vision-media.mjs': '部分用例需要真实 config（无则跳过，仍跑）'
};
const SKIP = new Set(['test-dsh-session-retire.mjs']);
// CI 侧排除口：QQ_BRIDGE_CI_SKIP='test-a.mjs,test-b.mjs'（只有拉 CI 时才设）。
// 为什么放环境变量而不是改这里：本仓库多窗口并行开发，套件清单冲突高；
// 局部门禁仍按同一份 CORE 跑，CI 才按 runner 能力缩。被排除的套件仍会在汇总行里列出原因。
const CI_SKIP = String(process.env.QQ_BRIDGE_CI_SKIP || '').split(',').map((name) => name.trim()).filter(Boolean);
for (const name of CI_SKIP) {
  SKIP.add(name);
  if (!NEEDS_ENV[name]) NEEDS_ENV[name] = 'CI 环境不适用（QQ_BRIDGE_CI_SKIP）';
}
const CORE = [
  'test-token-usage.mjs', 'test-token-economy.mjs', 'test-token-tools.mjs', 'test-token-providers.mjs', 'test-model-fallback.mjs', 'test-model-rejection-fallback.mjs', 'test-model-api-contract.mjs',
  'test-audit-bridge.mjs', 'test-media-queue.mjs', 'test-imagegen-tiered.mjs',
  'test-imagegen-quota.mjs', 'test-imagegen.mjs', 'test-imagegen-config.mjs', 'test-local-fallback.mjs',
  'test-voice-dedupe.mjs', 'test-safe-fetch-bounded.mjs', 'test-image-hash-async.mjs',
  'test-tts-ext.mjs', 'test-tts-gsv.mjs',
  'test-tts-fallback.mjs', 'test-observe-learn.mjs', 'test-media-search.mjs', 'test-heic.mjs', 'test-malformed-retry.mjs', 'test-attachment-classify.mjs', 'test-booth-meta.mjs', 'test-booth-parse.mjs', 'test-booth-archive.mjs', 'test-booth-classify.mjs', 'test-booth-merge.mjs', 'test-booth-errors.mjs', 'test-booth-cover.mjs', 'test-sticker-persist.mjs', 'test-sticker-cache.mjs', 'test-sticker-cache-api.mjs', 'test-sticker-repair.mjs', 'test-async-wait.mjs', 'test-api-contract-files.mjs', 'test-files-library-api.mjs', 'test-image-thumb.mjs', 'test-category-move.mjs', 'test-library-items.mjs', 'test-library-folders.mjs', 'test-library-notes.mjs', 'test-library-asset.mjs', 'test-library-scan.mjs', 'test-peak-local-all.mjs', 'test-peak-agent.mjs', 'test-model-scope.mjs', 'test-model-muted.mjs', 'test-model-routing.mjs', 'test-context-continuity.mjs', 'test-wake-selfid.mjs', 'test-quiet-watch.mjs', 'test-speaking-style.mjs', 'test-cross-session-memory.mjs', 'test-simple-booth-dir.mjs', 'test-config-transport.mjs', 'test-regression-guards.mjs', 'test-peak-local.mjs', 'test-peak-tone.mjs', 'test-config-hot-reload.mjs', 'test-sensitive.mjs', 'test-config-write-guard.mjs',
  'test-frame-retention.mjs', 'test-storage-stats.mjs', 'test-v2-wait.mjs',
  'test-stt-service.mjs', 'test-video-followup.mjs', 'test-stt-wiring.mjs', 'test-video-stt-flow.mjs',
  'test-mcp-safe.mjs', 'test-console-handler-scope.mjs', 'test-encoding-guard.mjs', 'test-dsh-endpoint.mjs', 'test-vision-media.mjs', 'test-sent-media-timeline.mjs', 'test-video-text-normalize.mjs', 'test-quoted-messages.mjs', 'test-member-notes.mjs', 'test-state-backup.mjs', 'test-token-controls.mjs', 'test-send-pacing.mjs', 'test-system-power.mjs', 'test-console-host.mjs', 'test-ops-tools.mjs', 'test-autostart.mjs', 'test-update-source.mjs', 'test-impressions-run.mjs', 'test-media-send-limit.mjs',
  'test-stickers.mjs', 'test-sticker-collect-rules.mjs', 'test-impressions.mjs', 'test-slang-preselect.mjs', 'test-setup-wizard.mjs', 'test-pack-exclude.mjs'
];

// M6 归档线（P0 一致性 / P1 能力 / P2 暂停·断点·sidecar）整组登记。
// 为什么单列再 push 而不住上面数组末尾加：那一段是所有窗口都在追加的高冲突区
// （D12 的 test-pack-exclude、w1 待合的 test-affinity 都加在末尾）。外置成一组，
// 以后归档线再扩套件也不用碰同一行。
const ARCHIVE_CORE = [
  'test-archive-atomic.mjs', 'test-archive-contentkey.mjs', 'test-archive-lock.mjs',
  'test-archive-path.mjs',
  'test-archive-p1-recycle.mjs', 'test-archive-p1-zip.mjs', 'test-archive-p1-maintain.mjs',
  'test-archive-p2-pause.mjs', 'test-archive-p2-progress.mjs', 'test-archive-p2-sidecar.mjs',
  'test-archive-p2-transfer.mjs'
];
CORE.push(...ARCHIVE_CORE);

// 本轮新增守卫：M7 好感度纯逻辑（w1 待合）、D34 迁移后会话 cwd 自愈、D37 自报模型。
// 单列一组，避免再挤上面那行所有窗口都在追加的高冲突区。
const GUARD_CORE = ['test-affinity.mjs', 'test-affinity-endpoint.mjs', 'test-persona-guidance.mjs', 'test-session-cwd-guard.mjs', 'test-self-model.mjs', 'test-stt-quality.mjs', 'test-code-size.mjs', 'test-self-check.mjs'];
CORE.push(...GUARD_CORE);

// D45：上下文预算回收（决策 / TTL+单飞探针 / 轮末接线断言，与 src/context-budget.js 同批）
// D46：效果量化探针（解析 [预算] 日志 + token-usage 前后对比；报告错了比没有更糟，所以也进闸门）
const BUDGET_CORE = ['test-context-budget.mjs', 'test-budget-effect.mjs', 'test-session-resets.mjs'];
CORE.push(...BUDGET_CORE);

// D70：AI 黑名单（配置规范化 / 三处唤醒闸 / 冷却与小时上限 / 控制台端点 / prompt 注入）。
// D73：AI 黑名单的 QQ 私聊命令（/aiban 解析与执行，含「不进 DSH 回合」的接线断言）。
// 单列一组，避免再挤上面那行所有窗口都在追加的高冲突区。
const AI_CORE = ['test-ai-blacklist.mjs', 'test-ai-blacklist-gate.mjs', 'test-lists-note.mjs', 'test-ai-command.mjs', 'test-console-token.mjs', 'test-console-guest.mjs', 'test-budget-alert.mjs', 'test-booth-search.mjs', 'test-booth-pause.mjs', 'test-library-binds.mjs', 'test-library-bind-io.mjs', 'test-library-bind-match.mjs', 'test-library-extracted.mjs', 'test-library-find.mjs', 'test-library-find-by-image.mjs', 'test-library-assets-filter.mjs', 'test-library-asset-detail.mjs', 'test-library-category.mjs', 'test-library-facets.mjs', 'test-library-manual-meta.mjs', 'test-library-alias.mjs', 'test-library-reconcile.mjs', 'test-library-reconcile-sync.mjs', 'test-library-covers.mjs', 'test-library-cover.mjs', 'test-library-archive-info.mjs', 'test-library-usage.mjs', 'test-library-trash.mjs', 'test-library-trash-storage.mjs', 'test-library-batch-ops.mjs', 'test-library-relocate.mjs', 'test-library-merge.mjs', 'test-library-rename.mjs', 'test-library-tagging.mjs', 'test-library-batch.mjs', 'test-library-download.mjs', 'test-library-extract.mjs', 'test-library-import-files.mjs', 'test-library-passwords.mjs', 'test-token-tools-api.mjs', 'test-library-collections.mjs', 'test-library-purchases.mjs', 'test-library-purchases-sync.mjs', 'test-open-url.mjs', 'test-agent-contract.mjs', 'test-agent-openai.mjs', 'test-agent-openai-e2e.mjs', 'test-agent-xml-tool-calls.mjs',
    'test-identity-lock.mjs', 'test-agent-extra-body.mjs', 'test-agent-probe.mjs', 'test-agent-local-model.mjs', 'test-agent-http.mjs', 'test-booth-login.mjs', 'test-booth-download.mjs', 'test-booth-product.mjs', 'test-zip-read.mjs', 'test-zip-crypto.mjs', 'test-unitypackage-cover.mjs', 'test-zip-extract.mjs', 'test-state-backup-coverage.mjs', 'test-role-draft.mjs', 'test-check-dsh-bundle-drift.mjs', 'test-library-duplicates.mjs', 'test-library-duplicates-api.mjs', 'test-library-purchase-detail.mjs', 'test-library-dhash.mjs', 'test-pack-release.mjs', 'test-library-scan-cache.mjs', 'test-extract-code.mjs', 'test-log-rotate.mjs', 'test-attribution-guard.mjs'];
CORE.push(...AI_CORE);

// D66：长截图纵向切片（纯函数几何 + 真 ffmpeg 端到端）。之前只跑单测、没进任何 CORE，
// 改坏 media-normalize 的切片分支不会有红灯 —— 所以补进来。单列一组，方便以后加视觉类套件。
const MEDIA_CORE = ['test-long-image-tiling.mjs'];
CORE.push(...MEDIA_CORE);

// T15/T16/T20 交付的客户端三套（设计 token / client 页面 / WebView2 宿主）。
// 之前三套都只在各自窗口单跑、不进任何回归数组：改坏 client.html 或 desktop/Host.cs 不会有红灯。
// 单列一组，客户端后续加套件只改这一行，不去挤上面的高冲突区。
const UI_CORE = ['test-ui-design.mjs', 'test-client-ui.mjs', 'test-desktop-host.mjs', 'test-changelog.mjs', 'test-bgm.mjs', 'test-halo-skin.mjs'];
CORE.push(...UI_CORE);

// T17 安装器/卸载链路（build-installer.ps1 + scripts/installer/ + 载荷清单）。
// 之前只单跑：改坏安装脚本、payload 或卸载流程不会有红灯。单列一组，后续加安装类套件只改这一行。
const INSTALL_CORE = ['test-installer.mjs'];
CORE.push(...INSTALL_CORE);

// 文件库「转存口径」条件规则（纯函数判定顺序 + 默认值与老 shouldArchiveAttachment 的一致性）。
// 单列一组：这是 fileArchive.rules 的唯一行为闸门，判定顺序改错只会在真群里静默少存文件，
// 必须有红灯兜着；以后加规则类套件也只改这一行。
const RULES_CORE = ['test-archive-rules.mjs'];
CORE.push(...RULES_CORE);

// 对话层纯规则：私聊「加好友」提示、纯净模式（省 token 的分段过滤）、「@我 + /persona」命令识别。
// 三个都是桥接装配时被调用的纯函数（接线由别的窗口做）；纯函数改错不会有别的红灯兜住，单列一组。
// 再加人设 prompt 拼装：换非 DSH agent 时桥接要自己拼 system prompt，这里拼错没人兜。
// prompt-parity 是对着 wake-prompts.js 源码数的「覆盖度」：换后端后哪段会空、哪段必须保留，
// 这类「以后改提示词顺序才翻车」的问题只有源码级断言能兜住。
const CONVERSATION_CORE = ['test-private-hint.mjs', 'test-pure-mode.mjs', 'test-mention-command.mjs', 'test-conversation-wiring.mjs', 'test-persona-prompt.mjs', 'test-prompt-parity.mjs', 'test-memewiki.mjs',
  'test-memewiki-import.mjs', 'test-zhipu-vision.mjs', 'test-image-memory.mjs'];
CORE.push(...CONVERSATION_CORE);

const useAll = process.argv.includes('--all');
const files = useAll
  ? fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.startsWith('test-') && f.endsWith('.mjs'))
  : CORE;
// CORE 里写错的套件名以前会被 existsSync 静默滤掉 —— 效果是「登记了但永远不跑」，闸门假绿。
// 现在只要 CORE 里有名字对不上盘上文件，就直接判失败（exit 2，与「套件跑红」的 exit 1 区分）。
const missingCore = useAll ? [] : CORE.filter((f) => !fs.existsSync(path.join(ROOT, 'scripts', f)));
if (missingCore.length) {
  console.error(`❌ CORE 里登记的套件在 scripts/ 下不存在（不会静默跳过）：${missingCore.join(', ')}`);
  process.exit(2);
}
const targets = files.filter((f) => !SKIP.has(f) && fs.existsSync(path.join(ROOT, 'scripts', f)));

const results = [];
for (const f of targets) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', f)], { encoding: 'utf8', timeout: 120000 });
  const tail = String(r.stdout || r.stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
  results.push({ f, ok: r.status === 0, tail: tail.slice(0, 110) });
}
const bad = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.f.padEnd(32)} ${r.tail}`);
console.log(`\n${bad.length ? '❌' : '✅'} ${results.length - bad.length}/${results.length} 套件通过${bad.length ? `（失败：${bad.map((b) => b.f).join(', ')}）` : ''}`);
if (SKIP.size) console.log(`跳过：${[...SKIP].map((s) => `${s}（${NEEDS_ENV[s] ?? '需环境'}）`).join(', ')}`);
process.exit(bad.length ? 1 : 0);

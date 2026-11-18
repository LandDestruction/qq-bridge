// console/stickers-voices: extracted bridge responsibilities; no startup side effects.
// Live dependencies: STATE_DIR, STICKER_FILE, appendActivity, applyStickerNoteV2, atomicWriteJson, cfg, collectStickerV2, describeAudio, formatStickerList, fs, getSocialV2State, inspectAudio, lastForcedAgentStickerSync, listAudioFiles, log, path, saveSocialV2State, setStickerRemarkV2, stickerEnabled, stickerEntries, stickerStoreWritable, stickerSyncedAt, syncStickerLibrary, v2ToolEnabled, voiceCfg
export function createConsoleStickersVoices(deps) {
// @bridge-function handleConsoleStickersVoices:start
async function handleConsoleStickersVoices(request) {
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/collect-sticker') {
          if (!(0, deps.stickerEnabled)()) { request.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; /* @bridge-handled */ }
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { request.sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('collectSticker')) { request.sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return true; /* @bridge-handled */ }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          const collectCfg = deps.cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { request.sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return true; /* @bridge-handled */ }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            request.sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return true; /* @bridge-handled */
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await (0, deps.collectStickerV2)(key, messageRef, remark);
            (0, deps.saveSocialV2State)();
            (0, deps.log)(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            (0, deps.appendActivity)(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            request.sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            (0, deps.saveSocialV2State)();
            (0, deps.log)(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            request.sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return true; /* @bridge-handled */
        }
        // 语音库列表。两条通道共用：
        //   - 带 agent token（AI 的 qq_list_voices）→ 必须带 key，校验会话白名单/工具开关；
        //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
        // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
        if (request.req.method === 'GET' && (request.url.pathname === '/api/socialV2/voices' || request.url.pathname === '/api/voice/list')) {
          const key = String(request.url.searchParams.get('key') ?? '').trim();
          const voice = (0, deps.voiceCfg)();
          const agentCall = Boolean(request.req.headers['x-agent-token']);
          // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
          if (agentCall && !voice.enabled) { request.sendJson({ ok: false, error: '语音功能已关闭' }, 403); return true; /* @bridge-handled */ }
          if (agentCall && !key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (agentCall && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (agentCall && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (agentCall && !(0, deps.v2ToolEnabled)('sendVoice')) { request.sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return true; /* @bridge-handled */ }
          const wantProbe = request.url.searchParams.get('probe') !== '0';
          try {
            const files = (0, deps.listAudioFiles)(voice.dir);
            const items = [];
            for (const f of files.slice(0, 100)) {
              const entry = { name: deps.path.relative(voice.dir, f).split(deps.path.sep).join('/') };
              if (wantProbe) {
                const info = await (0, deps.inspectAudio)(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
                entry.ok = info.ok;
                entry.bytes = info.size;
                entry.detail = info.ok ? (0, deps.describeAudio)(info) : null;
                entry.seconds = info.duration ?? null;
                if (!info.ok) entry.error = info.error;
              }
              items.push(entry);
            }
            request.sendJson({
              ok: true,
              key: key || null,
              dir: agentCall ? undefined : voice.dir,
              count: items.length,
              voices: items,
              limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
              // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
              // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
              hint: items.length
                ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
                : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
            });
          } catch (error) {
            request.sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
          }
          return true; /* @bridge-handled */
        }

        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/sticker-list') {
          if (!(0, deps.stickerEnabled)()) { request.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; /* @bridge-handled */ }
          const key = String(request.url.searchParams.get('key') ?? '').trim();
          const query = String(request.url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(deps.cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(request.url.searchParams.get('count')) || 48, maxCount)));
          // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
          // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
          // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
          const force = false;
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('listStickers')) { request.sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return true; /* @bridge-handled */ }
          try {
            const synced = await (0, deps.syncStickerLibrary)(force);
            const list = (0, deps.formatStickerList)(synced?.entries ?? deps.stickerEntries, query, count);
            request.sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? deps.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            request.sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/sticker-list') {
          if (!(0, deps.stickerEnabled)()) { request.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; /* @bridge-handled */ }
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const maxCount = Math.max(1, Number(deps.cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
          let force = body.refresh === true;
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('listStickers')) { request.sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return true; /* @bridge-handled */ }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (request.req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - deps.lastForcedAgentStickerSync < 10000) force = false;
            else deps.lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await (0, deps.syncStickerLibrary)(force);
            const list = (0, deps.formatStickerList)(synced?.entries ?? deps.stickerEntries, query, count);
            request.sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? deps.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            request.sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return true; /* @bridge-handled */
        }
        // 管理端表情库接口（控制台）
        if (request.req.method === 'GET' && request.url.pathname === '/api/stickers') {
          const query = String(request.url.searchParams.get('query') ?? '').trim();
          // 控制台专用列表：maxListCount 是给 AI 工具（qq_list_stickers）的单次上限，
          // 不是控制台的上限。以前这里错误地套用了 maxListCount(100)，
          // 导致 ops「表情包注释」只拿到 100 条（24/页 → 5 页），而 total 仍是 279 → 页数与总数对不上。
          const rawCount = Number(request.url.searchParams.get('count'));
          // count 上限仍是 500（与 formatStickerList 的硬上限一致，不放宽）：超过 500 的翻页需求走 offset。
          const count = Math.min(500, Math.max(1, Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 48));
          // offset：非负整数分页起点；负数 / 非数字 / 小数一律按 0（读接口不因垃圾参数报错），
          // 越界（> matched）返回空数组 + hasMore:false，由 formatStickerList 统一处理。
          const rawOffset = Number(request.url.searchParams.get('offset'));
          const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
          // sort：new/old/usable/understand/used；未知值交给 formatStickerList 退回 new。
          const sort = String(request.url.searchParams.get('sort') ?? '').trim();
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await (0, deps.syncStickerLibrary)(false);
            const list = (0, deps.formatStickerList)(synced?.entries ?? deps.stickerEntries, query, count, offset, sort);
            request.sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? deps.stickerSyncedAt, fromCache: synced?.fromCache ?? false, writable: deps.stickerStoreWritable });
          } catch (error) {
            request.sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/stickers/sync') {
          try {
            const synced = await (0, deps.syncStickerLibrary)(true);
            request.sendJson({ ok: true, total: synced?.entries?.length ?? deps.stickerEntries.length, syncedAt: synced?.syncedAt ?? deps.stickerSyncedAt });
          } catch (error) {
            request.sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/stickers/note') {
          const body = await request.readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { request.sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return true; /* @bridge-handled */ }
          const entry = (0, deps.applyStickerNoteV2)(stickerId, note, tags, usage);
          if (!entry) { request.sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return true; /* @bridge-handled */ }
          request.sendJson({ ok: true, sticker: entry });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/stickers/remark') {
          const body = await request.readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { request.sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return true; /* @bridge-handled */ }
          try {
            const entry = await (0, deps.setStickerRemarkV2)(stickerId, String(body.remark ?? ''));
            request.sendJson({ ok: true, sticker: entry });
          } catch (error) {
            request.sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return true; /* @bridge-handled */
        }
        // 表情库去重（POST /api/stickers/dedupe）：同一份内容被重复登记时只留一条。
        //
        // 为什么扫**磁盘原文**、而不是 deps.stickerEntries：loadStickerStore / saveStickerStore 都会过
        // dedupeStickerEntries，内存里早就合并成一条了；历史上攒下的重复只活在库文件里，
        // 面板要清的正是文件那一份，所以这里直读文件、只改文件（内存不动，避免两份状态打架）。
        // 语义刻意保守：只按「同一份内容」（md5 → emojiId → 去 query 的 url → id）分组，
        // 不做视觉相似合并；只删数据记录，**绝不删 state/sticker-files/ 里的图片**
        // ——同一张图可能还被别的记录引用，删文件不可逆。
        if (request.req.method === 'POST' && request.url.pathname === '/api/stickers/dedupe') {
          if (!deps.stickerStoreWritable) { request.sendJson({ ok: false, error: '表情库处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接' }, 503); return true; /* @bridge-handled */ }
          const body = await request.readBody();
          const apply = body?.apply === true;
          let plan = null;
          try {
            const text = deps.fs.readFileSync(deps.STICKER_FILE, 'utf8').replace(/^\uFEFF/, '');
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) throw new Error('顶层不是数组');
            plan = planStickerDedupe(parsed);
          } catch (error) {
            request.sendJson({ ok: false, error: `表情库文件读取失败：${error?.message ?? error}` }, 500);
            return true; /* @bridge-handled */
          }
          const { scanned, groups, kept, duplicates } = plan;
          // 预览：只报数，不落盘（"预览/应用"是两段式契约，误点按钮不能直接删收藏）。
          if (!apply) {
            request.sendJson({ ok: true, apply: false, scanned, duplicates, groups, merged: duplicates, before: scanned, after: scanned - duplicates });
            return true; /* @bridge-handled */
          }
          if (!duplicates) {
            // 幂等：已经没有重复时不做任何写入，也就没有备份可给。
            request.sendJson({ ok: true, apply: true, scanned, removed: 0, kept: kept.length, backup: null, merged: 0, before: scanned, after: scanned });
            return true; /* @bridge-handled */
          }
          let backup = '';
          try {
            const pad = (n) => String(n).padStart(2, '0');
            const now = new Date();
            const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            backup = `${deps.STICKER_FILE}.bak-${stamp}`;
            // 同一秒内连续 apply（或已有同名备份）时加序号：绝不覆盖上一份备份。
            for (let i = 2; deps.fs.existsSync(backup); i += 1) backup = `${deps.STICKER_FILE}.bak-${stamp}-${i}`;
            // 先备份再原子写：写盘走 atomicWriteJson（tmp + rename），中途失败也留原件。
            deps.fs.copyFileSync(deps.STICKER_FILE, backup);
            (0, deps.atomicWriteJson)(deps.STICKER_FILE, kept);
          } catch (error) {
            request.sendJson({ ok: false, error: `表情库去重失败：${error?.message ?? error}` + (backup ? `（备份：${deps.path.basename(backup)}）` : '') }, 500);
            return true; /* @bridge-handled */
          }
          const backupLabel = (() => {
            try {
              return deps.path.relative(deps.path.dirname(deps.STATE_DIR), backup).split(deps.path.sep).join('/');
            } catch { return backup; }
          })();
          (0, deps.log)(`[sticker] 去重：${scanned} 条 → 删除 ${duplicates} 条，保留 ${kept.length} 条（备份 ${backupLabel}）`);
          request.sendJson({ ok: true, apply: true, scanned, removed: duplicates, kept: kept.length, backup: backupLabel, merged: duplicates, before: scanned, after: kept.length });
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleStickersVoices:end
  return { handleConsoleStickersVoices };
}

// 去重规划（纯函数）：按「同一份内容」分组，组内留 useCount 最大的一条，并列时取 id 字典序最小的
// ——并列必须有确定规则，否则同一份库连点两次「预览」都可能换主条，用户看不出哪条会留下。
// useCount 改成组内求和（与 dedupeStickerEntries 的合并语义一致）：只删记录不该顺便丢掉使用次数。
export function planStickerDedupe(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object');
  const useCountOf = (e) => Math.max(0, Number(e.useCount ?? e.usedCount ?? e.uses ?? e.count) || 0);
  const idOf = (e) => String(e.id ?? e.resId ?? '');
  const groups = new Map();
  for (const entry of list) {
    const md5 = String(entry.md5 ?? '').trim().toLowerCase();
    const emojiId = String(entry.emojiId ?? '').trim();
    // ⚠️ 不用 url 当判据：QQ 图链 `https://multimedia.nt.qq.com.cn/download?appid=…&fileid=…`
    // 的 path 对所有图片都一样，真正的身份在 query 里；而 query 带会过期的签名，
    // 同一张图两次登记反而不一样。按 url（无论剥不剥 query）分组都会错杀：
    // 实测线上 4 张完全不同的手动收藏共用 path，剥 query 后被判成同一张。
    // 所以只有 md5 / emojiId / id 这三种「真身份」能作为合并依据 —— 宁可漏去重，也不误删。
    const key = md5 ? `md5:${md5}` : emojiId ? `emoji:${emojiId}` : `id:${idOf(entry)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const kept = [];
  const duplicates = [];
  for (const [key, members] of groups) {
    if (members.length === 1) { kept.push(members[0]); continue; }
    const sorted = [...members].sort((a, b) => useCountOf(b) - useCountOf(a) || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
    const main = { ...sorted[0], useCount: members.reduce((n, e) => n + useCountOf(e), 0) };
    const drop = sorted.slice(1);
    kept.push(main);
    duplicates.push({
      key,
      keep: idOf(main),
      drop: drop.map(idOf),
      // files 只用于展示「重复的是哪张图」：优先给 md5，其次是本地文件名，最后退回 id。
      files: [...new Set(members.map((e) => String(e.md5 || '').trim().toLowerCase() || String(e.file || '').trim() || idOf(e)).filter(Boolean))]
    });
  }
  // duplicates 是「要删掉的记录条数」（= 各组 drop 之和），不是重复组数：
  // apply 回的 removed 必须与预览的 duplicates 一致，前端才能拿它做「合并 N 条」的文案。
  return { scanned: list.length, duplicates: duplicates.reduce((n, g) => n + g.drop.length, 0), groups: duplicates, kept };
}

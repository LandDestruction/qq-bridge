// group-commands-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AbortSignal, adminCmdLast, api, canRun, cfg, ensureSlangLearnerSession, fetch, fs, getSocialV2State, groupMuteFile, groupMutes, groupRoleCache, listCommands, log, messageDb, parseCommand, parseDuration, personaGuideCooldown, personaGuidePending, saveSocialV2State, searchHistory, sendToQQ, slangEntries, stickerEntries, summaryInFlight, waitLearnerTurn
export function createGroupCommandsRuntime(deps) {
// @bridge-function saveGroupMutes:start
function saveGroupMutes() { try { deps.fs.writeFileSync(deps.groupMuteFile, JSON.stringify(deps.groupMutes, null, 2), 'utf8'); } catch {} }
// @bridge-function saveGroupMutes:end

// @bridge-function muteUntilOf:start
function muteUntilOf(key) { const t = Number(deps.groupMutes[key] || 0); return t > Date.now() ? t : 0; }
// @bridge-function muteUntilOf:end

// @bridge-function setMute:start
function setMute(key, ms) {
    if (ms > 0) deps.groupMutes[key] = Date.now() + ms; else delete deps.groupMutes[key];
    saveGroupMutes();
  }
// @bridge-function setMute:end

// @bridge-function callerTierOf:start
async function callerTierOf(groupId, userId) {
    const uid = String(userId || '');
    if (!uid) return 'member';
    if (String(deps.cfg.ownerQQ || '') === uid) return 'owner';
    const ck = `${groupId}:${uid}`;
    const hit = deps.groupRoleCache.get(ck);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.role;
    let role = 'member';
    try {
      const H = String(deps.cfg.snowluma?.httpUrl || '').replace(/\/+$/, '');
      const auth = deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {};
      const r = await (0, deps.fetch)(`${H}/get_group_member_info`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ group_id: Number(groupId), user_id: Number(uid), no_cache: false }),
        signal: deps.AbortSignal.timeout(5000)
      });
      const j = await r.json().catch(() => ({}));
      const v = String(j?.data?.role || '');
      if (v === 'owner' || v === 'admin') role = 'admin';
    } catch {}
    deps.groupRoleCache.set(ck, { role, at: Date.now() });
    return role;
  }
// @bridge-function callerTierOf:end

// @bridge-function generatePersonaCard:start
async function generatePersonaCard(desc) {
    try {
      const sessionId = await (0, deps.ensureSlangLearnerSession)();
      const promptText = [
        '你要根据一句话需求，设计一个用于单人对话的角色。',
        `需求：${String(desc).slice(0, 600)}`,
        '输出要求（严格遵守）：',
        '第一段：5 行字段，每行一个：名字 / 身份 / 性格 / 说话方式 / 口头禅',
        '第二段：空一行后，写 3 组示例对话，每组两行，格式：',
        '  对方：<一句挑衅或普通的话>',
        '  你：<这个角色会怎么回，要有鲜明的口吻和态度>',
        '约束：每行不超过 40 字；不要 markdown、不要编号、不要解释；',
        '角色可以刻薄、傲慢、阴阳怪气，但不写脏话、不写性内容、不威胁人身安全。'
      ].join('\n');
      const accepted = await deps.api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) return null;
      const out = String(await (0, deps.waitLearnerTurn)(sessionId, 60000) || '').trim();
      if (!out) return null;
      const blocks = out.split(/\n\s*\n/);
      const fieldLines = String(blocks[0] || '').split('\n').map((l) => l.replace(/^[\d\.\-\*\s]+/, '').trim()).filter(Boolean).slice(0, 5);
      if (!fieldLines.length) return null;
      const samples = String(blocks[1] || '').split('\n').map((l) => l.trim()).filter((l) => /^(对方|你)：/.test(l)).slice(0, 6);
      return { card: fieldLines.join('；').slice(0, 600), samples };
    } catch (error) {
      (0, deps.log)('[persona] 角色卡生成失败:', error?.message ?? error);
      return null;
    }
  }
// @bridge-function generatePersonaCard:end

// @bridge-function summarizeGroupWindow:start
async function summarizeGroupWindow(key, sinceMs, mode = 'summary') {
    if (deps.summaryInFlight) return { ok: false, error: '已经有一份总结在生成，稍等。' };
    deps.summaryInFlight = true;
    try {
      const db = (0, deps.messageDb)();
      if (!db) return { ok: false, error: '消息库不可用。' };
      let rows = [];
      try {
        rows = db.prepare('SELECT ts, sender, text FROM messages WHERE key = ? AND ts >= ? ORDER BY ts DESC LIMIT 200').all(key, sinceMs);
      } catch {
        rows = [];
      }
      if (!rows.length) return { ok: false, error: '这段时间没有消息。' };
      rows.reverse();
      const lines = rows.map((r) => `${new Date(Number(r.ts)).toLocaleTimeString('zh-CN', { hour12: false })} ${r.sender || '群友'}：${String(r.text || '').slice(0, 80)}`);
      const sessionId = await (0, deps.ensureSlangLearnerSession)();
      const promptText = [
        '你在为群聊做阶段性总结。下面是按时间顺序的聊天记录：',
        lines.join('\n'),
        '',
        mode === 'todo'
          ? '请只抽取「约定与待办」：谁答应了什么、约了几点/哪天做什么、还有什么没做完。每条一行，以 - 开头；没有就输出「没有发现约定或待办」。不要总结话题，不要寒暄。'
          : '请用 3~6 句话总结：①主要话题 ②达成的一致/结论 ③还没解决的争议或待办。',
        mode === 'todo' ? '' : '只输出总结正文，不要寒暄、不要 markdown 标题、不要复述每条消息。'
      ].join('\n');
      const accepted = await deps.api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) return { ok: false, error: `模型拒绝：${accepted.result.error?.code || ''}` };
      const out = await (0, deps.waitLearnerTurn)(sessionId, 90000);
      const text = String(out || '').trim();
      return text ? { ok: true, text, count: rows.length } : { ok: false, error: '模型没有返回内容。' };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    } finally {
      deps.summaryInFlight = false;
    }
  }
// @bridge-function summarizeGroupWindow:end

// @bridge-function handleGroupCommand:start
async function handleGroupCommand(kind, id, key, event) {
    if (kind !== 'group') return false;
    const raw = String(event.raw_message ?? '').trim();
    if (!raw.startsWith('/')) return false;
    const cmd = (0, deps.parseCommand)(raw);
    if (!cmd) return false;
    const tier = await callerTierOf(id, event.user_id);
    // 管理指令限流：同一群每分钟最多 1 条（防止刷指令）。
    const ADMIN_CMDS = new Set(['stop', 'resume', 'mute', 'summary', 'todo', 'who']);
    if (ADMIN_CMDS.has(cmd.name)) {
      const last = deps.adminCmdLast.get(key) || 0;
      if (Date.now() - last < 60 * 1000) {
        return true; // 静默丢弃，不回复，避免刷屏
      }
      deps.adminCmdLast.set(key, Date.now());
    }
    if (!(0, deps.canRun)(cmd.name, tier)) {
      await (0, deps.sendToQQ)(key, '这个指令需要群管理权限（群主/管理员/机器人主人）。');
      return true;
    }
    try {
      if (cmd.name === 'stop') {
        const ms = (0, deps.parseDuration)(cmd.args, 0);
        setMute(key, ms > 0 ? ms : 7 * 24 * 3600 * 1000);
        await (0, deps.sendToQQ)(key, ms > 0 ? `好，静默 ${Math.round(ms / 60000)} 分钟。` : '好，我先闭嘴。喊 /resume 叫我。');
      } else if (cmd.name === 'resume') {
        setMute(key, 0);
        await (0, deps.sendToQQ)(key, '回来了。');
      } else if (cmd.name === 'todo') {
        const ms = (0, deps.parseDuration)(cmd.args, 24 * 3600 * 1000);
        const since = Date.now() - Math.max(10 * 60 * 1000, ms);
        const result = await summarizeGroupWindow(key, since, 'todo');
        if (!result.ok) await (0, deps.sendToQQ)(key, `抽取失败：${result.error}`);
        else await (0, deps.sendToQQ)(key, `【最近 ${Math.round(ms / 3600000)} 小时的约定与待办｜${result.count} 条消息】\n${result.text.slice(0, 900)}`);
      } else if (cmd.name === 'summary') {
        const ms = (0, deps.parseDuration)(cmd.args, 2 * 3600 * 1000);
        const since = Date.now() - Math.max(5 * 60 * 1000, ms);
        const result = await summarizeGroupWindow(key, since);
        if (!result.ok) await (0, deps.sendToQQ)(key, `总结失败：${result.error}`);
        else await (0, deps.sendToQQ)(key, `【最近 ${Math.round(ms / 60000)} 分钟｜${result.count} 条消息】\n${result.text.slice(0, 900)}`);
      } else if (cmd.name === 'help') {
        const list = (0, deps.listCommands)(tier);
        const lines = list.map((c) => `${c.usage} — ${c.desc}`);
        await (0, deps.sendToQQ)(key, `我能用的指令：\n${lines.join('\n')}`);
      } else if (cmd.name === 'search') {
        if (!cmd.args) { await (0, deps.sendToQQ)(key, '用法：/search 关键词'); return true; }
        const found = (0, deps.searchHistory)({ key, q: cmd.args, limit: 5 });
        const items = (found.items || []).map((it) => `· ${it.time.slice(5, 16)} ${it.sender}：${it.text.slice(0, 60)}`);
        await (0, deps.sendToQQ)(key, items.length ? `找到 ${found.count} 条：\n${items.join('\n')}` : '没搜到。');
      } else if (cmd.name === 'who') {
        const ms = (0, deps.parseDuration)(cmd.args, 24 * 3600 * 1000);
        const since = Date.now() - Math.max(10 * 60 * 1000, ms);
        const db = (0, deps.messageDb)();
        let rows = [];
        try { rows = db.prepare('SELECT sender, COUNT(*) n FROM messages WHERE key = ? AND ts >= ? GROUP BY sender ORDER BY n DESC LIMIT 8').all(key, since); } catch {}
        const total = rows.reduce((n, r) => n + Number(r.n || 0), 0);
        if (!rows.length) await (0, deps.sendToQQ)(key, '这段时间没有消息。');
        else await (0, deps.sendToQQ)(key, `【最近 ${Math.round(ms / 3600000)} 小时｜共 ${total} 条】\n${rows.map((r, i) => `${i + 1}. ${r.sender || '未知'}：${r.n} 条`).join('\n')}`);
      } else if (cmd.name === 'slang') {
        const q = cmd.args.trim();
        if (!q) { await (0, deps.sendToQQ)(key, '用法：/slang 词'); return true; }
        const hit = (Array.isArray(deps.slangEntries) ? deps.slangEntries : []).find((e) => String(e.content || '') === q) ||
          (Array.isArray(deps.slangEntries) ? deps.slangEntries : []).find((e) => String(e.content || '').includes(q));
        if (!hit) await (0, deps.sendToQQ)(key, `黑话库里没有「${q}」。`);
        else await (0, deps.sendToQQ)(key, `${hit.content}：${hit.meaning || '（没有释义）'}${hit.usage ? `（用法：${hit.usage}）` : ''}${hit.policy === 'usable' ? '' : '\n（只用于听懂，我不会主动用）'}`);
      } else if (cmd.name === 'persona') {
        deps.personaGuidePending.delete(key); // 用户已经会用指令了，别再补引导
        deps.personaGuideCooldown.delete(key);
        (0, deps.log)(`[cmd] persona key=${key} uid=${event.user_id} args=${JSON.stringify(cmd.args).slice(0,60)}`);
        const st0 = (0, deps.getSocialV2State)(key);
        st0.userPersonas = st0.userPersonas && typeof st0.userPersonas === 'object' ? st0.userPersonas : {};
        const uid0 = String(event.user_id || '');
        const want = String(cmd.args || '').trim();
        if (!want || want === 'who') {
          const cur = st0.userPersonas[uid0];
          await (0, deps.sendToQQ)(key, cur ? `你现在对我说话的样子：${cur.text}` : '还没给我设过性格。用法：/persona 你是一只猫娘');
        } else if (want === 'off' || want === '清除') {
          delete st0.userPersonas[uid0];
          (0, deps.saveSocialV2State)();
          await (0, deps.sendToQQ)(key, '好，恢复默认。');
        } else {
          const text = want.replace(/\s+/g, ' ').slice(0, 600);
          // 先告诉对方在造卡（造卡要一次模型调用，可能几秒）
          await (0, deps.sendToQQ)(key, `收到，我正在按「${text}」捏一个角色…`);
          const gen = await generatePersonaCard(text);
          st0.userPersonas[uid0] = { text, card: gen?.card || '', samples: Array.isArray(gen?.samples) ? gen.samples : [], at: Date.now() };
          (0, deps.saveSocialV2State)();
          await (0, deps.sendToQQ)(key, gen?.card
            ? `好了，以后你跟我说话时我是这个角色：\n${gen.card}\n（只对你生效，/persona off 可取消）`
            : `角色卡没生成成功，先按「${text}」的语气来；稍后再试 /persona 一次。`);
        }
      } else if (cmd.name === 'sticker') {
        const q = cmd.args.trim();
        if (!q) { await (0, deps.sendToQQ)(key, '用法：/sticker 场景或关键词'); return true; }
        const list = (Array.isArray(deps.stickerEntries) ? deps.stickerEntries : []).filter((e) => {
          const hay = [e.localNote, e.desc, ...(Array.isArray(e.tags) ? e.tags : [])].join(' ');
          return hay.includes(q);
        }).slice(0, 5);
        if (!list.length) await (0, deps.sendToQQ)(key, `没有匹配「${q}」的表情。`);
        else await (0, deps.sendToQQ)(key, `匹配 ${list.length} 张：\n${list.map((e) => `· ${(e.localNote || e.desc || e.id).slice(0, 30)}${e.tags?.length ? ` [${e.tags.slice(0, 2).join('/')}]` : ''}${e.policy === 'usable' ? ' 可发' : ' 只听懂'}`).join('\n')}`);
      } else {
        await (0, deps.sendToQQ)(key, `/${cmd.name} 还没接上，先用 /help 看看有哪些能用。`);
      }
    } catch (error) {
      (0, deps.log)(`指令执行失败 /${cmd.name}:`, error?.message ?? error);
    }
    return true;
  }
// @bridge-function handleGroupCommand:end
  return { saveGroupMutes, muteUntilOf, setMute, callerTierOf, generatePersonaCard, summarizeGroupWindow, handleGroupCommand };
}

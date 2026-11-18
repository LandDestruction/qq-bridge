// console/member-notes: 群友备注（控制台本地别名）; extracted bridge responsibilities; no startup side effects.
//
// 为什么需要：群名片/昵称会被人随时改，还常常是「√」「(1)」这类看不懂的符号，而同一个人的 QQ 号不变。
// 备注按 QQ 号存（一个人跨群一致），只写 state/member-notes.json，不动 QQ 侧任何数据、也不进提示词。
// 路由挂在 handleConsoleMessageDetail 的路由块上：console-server 的 server 函数有 527 行冻结基线，
// 单开一个 @bridge-routes 块会直接超线（成员列表本来也归那个模块管）。
// Live dependencies: STATE_DIR, fs, log, path
export function createConsoleMemberNotes(deps) {
  const FILE_NAME = 'member-notes.json';
  const NAME_MAX = 24;
  const NOTES_MAX = 5000;
  const ID_RE = /^\d{5,15}$/;

  function notesFile() {
    // STATE_DIR 为空时 path.join('') 会退化成相对路径、写进当前工作目录，所以先挡掉。
    if (!deps.STATE_DIR) return '';
    try {
      return deps.path.join(deps.STATE_DIR, FILE_NAME);
    } catch {
      return '';
    }
  }

  /** 备注一律压成单行、去首尾空白、限长：它是拿来一个人肉认人的短标签，不是第二条昵称。 */
  function normalizeName(raw) {
    return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  }

  function readStore() {
    const file = notesFile();
    if (!file) return { notes: Object.create(null) };
    let text;
    try {
      text = deps.fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') (0, deps.log)(`[群友备注] 读 state/${FILE_NAME} 失败：${error?.message ?? error}`);
      return { notes: Object.create(null) };
    }
    try {
      const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      const notes = parsed && typeof parsed.notes === 'object' && parsed.notes ? parsed.notes : {};
      return { notes };
    } catch (error) {
      // 坏文件不能静默覆盖：写路径会因为读不到旧内容而丢掉别人的备注，所以直接抛给调用方。
      throw new Error(`state/${FILE_NAME} 不是合法 JSON：${error?.message ?? error}`);
    }
  }

  function writeStore(store) {
    const file = notesFile();
    if (!file) throw new Error('STATE_DIR 不可用');
    // 先写 .tmp 再 rename：中途炸掉不会留下半个 JSON（和 state 里其它文件的写法保持一致）。
    const tmp = `${file}.tmp`;
    deps.fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, notes: store.notes }, null, 2)}\n`, 'utf8');
    deps.fs.renameSync(tmp, file);
  }

  function noteList(store) {
    const out = [];
    const notes = store.notes || {};
    for (const userId of Object.keys(notes)) {
      const name = normalizeName(notes[userId] && notes[userId].name);
      if (!ID_RE.test(userId) || !name) continue;
      out.push({ userId, name, at: String((notes[userId] && notes[userId].at) || '') });
    }
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)) || a.userId.localeCompare(b.userId));
    return out;
  }

// @bridge-function handleConsoleMemberNotes:start
async function handleConsoleMemberNotes(request) {
    if (request.url.pathname !== '/api/member-notes') return false;
    const method = request.req.method;
    try {
      if (method === 'GET') {
        const list = noteList(readStore());
        request.sendJson({ ok: true, count: list.length, notes: list });
        return true; /* @bridge-handled */
      }
      if (method !== 'POST') {
        request.sendJson({ ok: false, error: '群友备注只支持 GET/POST' }, 405);
        return true; /* @bridge-handled */
      }
      // 备注是「人给人看的」，智能体不需要也不该改；写接口一律只认管理端。
      if (request.req.headers['x-agent-call'] !== undefined || request.req.headers['x-agent-token']) {
        request.sendJson({ ok: false, code: 'admin_only', error: '群友备注只允许管理端读写（智能体不得自行改备注）' }, 403);
        return true; /* @bridge-handled */
      }
      const body = await request.readBody().catch(() => ({}));
      const userId = String(body.userId ?? '').trim();
      if (!ID_RE.test(userId)) {
        request.sendJson({ ok: false, error: 'userId 需要 5~15 位数字的 QQ 号' }, 400);
        return true; /* @bridge-handled */
      }
      const name = normalizeName(body.name);
      const store = readStore();
      const existed = Object.prototype.hasOwnProperty.call(store.notes, userId);
      if (!name) {
        delete store.notes[userId];
      } else {
        if (!existed && Object.keys(store.notes).length >= NOTES_MAX) {
          request.sendJson({ ok: false, error: `备注数量已到上限（${NOTES_MAX} 条），先清掉一些再存` }, 400);
          return true; /* @bridge-handled */
        }
        store.notes[userId] = { name, at: new Date().toISOString() };
      }
      writeStore(store);
      const list = noteList(store);
      request.sendJson({
        ok: true,
        removed: !name,
        note: name ? { userId, name, at: store.notes[userId].at } : null,
        count: list.length,
        notes: list
      });
      return true; /* @bridge-handled */
    } catch (error) {
      (0, deps.log)(`[群友备注] 处理失败：${error?.message ?? error}`);
      request.sendJson({ ok: false, error: `群友备注操作失败：${error?.message ?? error}` }, 500);
      return true; /* @bridge-handled */
    }
  }
// @bridge-function handleConsoleMemberNotes:end

  return { handleConsoleMemberNotes };
}

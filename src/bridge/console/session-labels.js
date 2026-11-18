// console/session-labels: 会话标签解析（群名/私聊对象名）; extracted bridge responsibilities; no startup side effects.
// 只读模块：不写盘、不调 QQ API、不创建会话状态（getSocialV2State 会为新 key 建状态，这里只在已有 conversations 里查）。
// 名字来源（按优先级，全部只读 state/ 缓存文件）：
//   群：state/group-names.json → deps.groupNameCache → 名称未知
//   私聊：state/friend-names.json → state/people.json 的 aliases（跳过「私聊」「我」）→ recentMessages sender → 名称未知
// Live dependencies: STATE_DIR, fs, groupNameCache, path, socialV2
export function createSessionLabels(deps) {
  const UNKNOWN = '名称未知';
  const SKIP_NAMES = new Set(['私聊', '我', '']);
  // state/*.json 的解析缓存：按 mtime 失效，避免每个请求都读一次磁盘；文件缺失/坏 JSON 当空对象。
  const jsonCache = new Map();

  function stateFilePath(name) {
    try {
      return deps.path.join(deps.STATE_DIR, name);
    } catch {
      return '';
    }
  }

  function readStateJson(name) {
    const file = stateFilePath(name);
    if (!file) return {};
    let mtime = null;
    try {
      mtime = Number(deps.fs.statSync(file).mtimeMs) || 0;
    } catch {
      mtime = null; // 假 deps / 文件缺失：仍然尝试直接读，读不到就走回退
    }
    const hit = jsonCache.get(name);
    if (hit && mtime !== null && hit.mtime === mtime) return hit.data;
    try {
      const raw = JSON.parse(deps.fs.readFileSync(file, 'utf8'));
      const data = raw && typeof raw === 'object' ? raw : {};
      if (mtime !== null) jsonCache.set(name, { mtime, data });
      return data;
    } catch {
      return {};
    }
  }

  function groupName(id) {
    const map = readStateJson('group-names.json');
    const fromFile = String(map[id] ?? '').trim();
    if (fromFile) return fromFile;
    try {
      const cached = deps.groupNameCache && typeof deps.groupNameCache.get === 'function'
        ? deps.groupNameCache.get(String(id))
        : '';
      const name = String(cached ?? '').trim();
      if (name) return name;
    } catch { /* 畸形缓存按没有处理 */ }
    return '';
  }

  function friendName(id) {
    const map = readStateJson('friend-names.json');
    return String(map[id] ?? '').trim();
  }

  // people.json: {people:{[qq]:{aliases:[{name,source:'card'|'sender',scope,lastSeenAt}]}}}
  // 群名片（card）比「发言名」更像一个人的固定昵称；同 source 取最近一次出现。
  function peopleAliasName(id) {
    const map = readStateJson('people.json');
    const person = map && map.people ? map.people[id] : null;
    const aliases = person && Array.isArray(person.aliases) ? person.aliases : [];
    let best = null;
    for (const alias of aliases) {
      if (!alias) continue;
      const name = String(alias.name ?? '').trim();
      if (SKIP_NAMES.has(name)) continue;
      const rank = alias.source === 'card' ? 2 : 1;
      const at = Number(alias.lastSeenAt) || 0;
      if (!best || rank > best.rank || (rank === best.rank && at > best.at)) best = { name, rank, at };
    }
    return best ? best.name : '';
  }

  function conversationOf(key) {
    try {
      const conversations = deps.socialV2 && deps.socialV2.conversations;
      if (!conversations || typeof conversations.get !== 'function') return null;
      return conversations.get(key) || null;
    } catch {
      return null;
    }
  }

  function senderNameOf(key) {
    const st = conversationOf(key);
    const list = st && Array.isArray(st.recentMessages) ? st.recentMessages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const msg = list[i];
      if (!msg || msg.isSelf) continue;
      const sender = String(msg.sender ?? '').trim();
      if (SKIP_NAMES.has(sender)) continue;
      return sender;
    }
    return '';
  }

  function privateName(key, id) {
    return friendName(id) || peopleAliasName(id) || senderNameOf(key) || UNKNOWN;
  }

// @bridge-function sessionLabel:start
  function sessionLabel(key) {
    const raw = String(key ?? '').trim();
    const match = /^(group|private):(.+)$/.exec(raw);
    if (!match) {
      // 空 key / 畸形 key：不抛异常，原样放进括号里，方便前端显示「名称未知（原文）」。
      const label = `${UNKNOWN}（${raw}）`;
      return { key: raw, kind: 'unknown', id: raw, name: UNKNOWN, label, display: label };
    }
    const kind = match[1];
    const id = match[2];
    const name = (kind === 'group' ? groupName(id) : privateName(raw, id)) || UNKNOWN;
    const label = `${name}（${id}）`;
    return { key: raw, kind, id, name, label, display: label };
  }
// @bridge-function sessionLabel:end

// @bridge-function sessionLabelsMap:start
  function sessionLabelsMap() {
    const labels = {};
    try {
      const conversations = deps.socialV2 && deps.socialV2.conversations;
      if (conversations && typeof conversations.keys === 'function') {
        for (const key of conversations.keys()) {
          const info = sessionLabel(key);
          labels[key] = { kind: info.kind, id: info.id, name: info.name, label: info.label };
        }
      }
    } catch { /* 单个会话畸形不应让整张表失败 */ }
    return labels;
  }
// @bridge-function sessionLabelsMap:end

  return { sessionLabel, sessionLabelsMap };
}

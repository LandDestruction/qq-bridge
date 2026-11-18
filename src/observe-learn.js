// 「观察学习」白名单：命中的群，AI **只看不说**——不唤醒、不回复、不发任何消息、不扣额度，
// 但仍然收集群成员词汇（黑话滚动窗口）与表情包（本地学习库，不动 bot 账号）。
//
// 语义优先级（用户明确要求）：观察优先于「允许回复」白名单。
// 即：同一个群既在 allow.groups 又在 observe.groups 时，按观察处理（不发言）。
// 待确认项：观察群里有人 @ 机器人 / 引用机器人的消息，当前也**不回**（保持只看不说）；
// 若以后要改成「被点名才回」，只需改 decideGroupEvent 一处并同步测试。

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v)))];
}

/**
 * 规范化 observe 配置。空 groups = 没有观察群（enabled=false 时同样不生效）。
 * @returns {{enabled:boolean,groups:string[],learnSlang:boolean,learnStickers:boolean}}
 */
export function normalizeObserveConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: src.enabled === true,
    groups: normalizeIdList(src.groups),
    // 学习开关：默认全开；关掉只会「不学」，不会变成会发言。
    learnSlang: src.learnSlang !== false,
    learnStickers: src.learnStickers !== false
  };
}

/** 该群是否命中观察学习白名单。 */
export function isObserveGroup(cfg, groupId) {
  const gid = String(groupId ?? '').trim();
  if (!gid) return false;
  return Boolean(cfg?.enabled) && Array.isArray(cfg.groups) && cfg.groups.includes(gid);
}

/**
 * 群消息的分流决策（纯函数，便于单测断言）。
 *
 * @param {{isObserve:boolean, isAllowListed:boolean, mentionsBot?:boolean,
 *          quotedBot?:boolean, isOwner?:boolean, learnSlang?:boolean, learnStickers?:boolean}} input
 * @returns {{observe:boolean, reply:boolean, learnSlang:boolean, learnStickers:boolean, reason:string}}
 */
export function decideGroupEvent(input = {}) {
  const isObserve = input.isObserve === true;
  if (isObserve) {
    return {
      observe: true,
      reply: false, // 观察优先：即使 @/引用/管理员，也不回复
      learnSlang: input.learnSlang !== false,
      learnStickers: input.learnStickers !== false,
      reason: input.mentionsBot || input.quotedBot
        ? '观察群：被点名也不回复（只看不说）'
        : '观察群：只学习不发言'
    };
  }
  return {
    observe: false,
    reply: input.isAllowListed === true,
    learnSlang: input.learnSlang !== false,
    learnStickers: input.learnStickers !== false,
    reason: input.isAllowListed === true ? '正常群：按白名单处理' : '非白名单群：不处理'
  };
}

/** 启动/命中时的可读日志，避免以后把「观察群很安静」误判成坏了。 */
export function describeObserveConfig(cfg) {
  if (!cfg?.enabled) return null;
  if (!Array.isArray(cfg.groups) || !cfg.groups.length) {
    return '观察学习白名单已启用，但 groups 为空：当前没有观察群';
  }
  const learn = [
    cfg.learnSlang === false ? null : '词汇',
    cfg.learnStickers === false ? null : '表情包'
  ].filter(Boolean).join('+') || '（学习项都已关闭）';
  return `观察学习白名单：${cfg.groups.join(',')}（这些群只在后台收集${learn}，不会唤醒/回复/发消息）`;
}

// ── 学习动作的「计划 + 执行」分离 ─────────────────────────────────────────
// 计划是纯数据，执行接收注入的 hooks：这样单测可以用假实现断言
// 「观察群确实调用了学习（且一次都没调发送）」，不必真的连 DSH / 改表情库。

/**
 * 从一条群消息里算出「该学什么」。不在观察群返回 null（调用方据此走正常流程）。
 * @returns {null|{groupId:string,key:string,sender:string,text:string,
 *   learnSlang:boolean,learnStickers:boolean,stickers:Array<{url:string,md5:string}>,reason:string}}
 */
export function planObserveLearning(event, cfg) {
  const groupId = String(event?.group_id ?? '');
  if (!isObserveGroup(cfg, groupId)) return null;
  const sender = String(event?.sender?.card || event?.sender?.nickname || event?.user_id || '未知');
  // 只学当前消息自己的文字（不学引用原文），与桥接 feedSlangWindow 的口径一致。
  const text = (Array.isArray(event?.message) ? event.message : [])
    .filter((s) => s?.type === 'text')
    .map((s) => String(s?.data?.text ?? ''))
    .join(' ')
    .trim();
  const stickers = [];
  for (const seg of Array.isArray(event?.message) ? event.message : []) {
    if (seg?.type !== 'image' && seg?.type !== 'face' && seg?.type !== 'mface') continue;
    const d = seg?.data ?? {};
    const url = String(d.url ?? '');
    const file = String(d.file ?? '');
    // 段里的 file 有时就是 md5；不是 32 位十六进制就不当 md5 用（避免把文件名当摘要）。
    const md5 = /^[0-9a-f]{32}$/i.test(file) ? file.toLowerCase() : '';
    // **不能**再要求 url：实测 QQ 表情在网关里经常是 image/face 段但 url 为空
    // （只有 file 或 face 段只有 id）。这些交给执行器用 get_image 兜底拿字节，
    // 拿不到时也必须留一条日志，不能静默丢。
    stickers.push({
      url,
      md5,
      file,
      faceId: String(d.id ?? ''),
      type: String(seg?.type ?? ''),
      summary: String(d.summary ?? '').slice(0, 40)
    });
  }
  const decision = decideGroupEvent({
    isObserve: true,
    isAllowListed: false,
    learnSlang: cfg.learnSlang !== false,
    learnStickers: cfg.learnStickers !== false
  });
  return {
    groupId,
    key: `group:${groupId}`,
    sender,
    text,
    learnSlang: decision.learnSlang && Boolean(text),
    learnStickers: decision.learnStickers && stickers.length > 0,
    stickers,
    reason: decision.reason
  };
}

/**
 * 诊断用：把消息里的 image/face/mface 段**形态**摘出来（只留前 32 字符的 file，
 * 绝不打完整 url —— url 里带 rkey/token，落日志就是泄露）。
 * 用于观察群「为什么表情没进库」的实测定位。
 */
export function describeObserveStickerSegments(event) {
  const out = [];
  for (const seg of Array.isArray(event?.message) ? event.message : []) {
    if (seg?.type !== 'image' && seg?.type !== 'face' && seg?.type !== 'mface') continue;
    const d = seg?.data ?? {};
    out.push({
      type: String(seg?.type ?? ''),
      hasUrl: Boolean(String(d.url ?? '')),
      hasFile: Boolean(String(d.file ?? '')),
      filePrefix: String(d.file ?? '').slice(0, 32),
      faceId: String(d.id ?? '').slice(0, 12)
    });
  }
  return out;
}

/**
 * 执行学习计划（hooks 全部由调用方注入；单测用假实现断言调用次数）。
 * 允许 async hook（拿字节/写盘是异步的）。
 * @param {object} plan planObserveLearning 的返回值（null 直接忽略）
 * @param {{feedSlang?:(key:string,sender:string,text:string)=>void,
 *          collectSticker?:(sticker:{url:string,md5:string,file:string,faceId:string,type:string},plan:object)=>any,
 *          onStickersSaved?:(count:number)=>void}} hooks
 * @returns {Promise<{slang:boolean,stickers:number}>}
 */
export async function applyObserveLearning(plan, hooks = {}) {
  if (!plan) return { slang: false, stickers: 0 };
  let slang = false;
  if (plan.learnSlang && typeof hooks.feedSlang === 'function') {
    hooks.feedSlang(plan.key, plan.sender, plan.text);
    slang = true;
  }
  let stickers = 0;
  if (plan.learnStickers && typeof hooks.collectSticker === 'function') {
    for (const sticker of plan.stickers) {
      // 允许 async：拿字节、写本地库都是异步的。hook 返回 null/undefined 表示没收到。
      const entry = await hooks.collectSticker(sticker, plan);
      if (entry) stickers += 1;
    }
    if (stickers > 0 && typeof hooks.onStickersSaved === 'function') await hooks.onStickersSaved(stickers);
  }
  return { slang, stickers };
}


/**
 * GET /api/observe/config 的响应形状（纯函数，路由与测试共用）。
 * effectiveGroups 只在「启用且有群」时等于 groups，否则为 [] ——
 * 前端只看 groups 会把 enabled=false 的残留配置误当成已生效。
 */
export function observeApiView(rawCfg, { source = 'config.json' } = {}) {
  const o = normalizeObserveConfig(rawCfg);
  return {
    enabled: o.enabled,
    groups: o.groups,
    learnSlang: o.learnSlang,
    learnStickers: o.learnStickers,
    description: describeObserveConfig(rawCfg) || null,
    effectiveGroups: o.enabled ? o.groups : [],
    source
  };
}

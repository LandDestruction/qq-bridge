// D62 装配阶段：配置装载、state/ 目录与单实例锁、会话状态、黑话库/表情库内存态。
// 纯搬运：语句顺序与拆分前 main() 一致；无 import，依赖全部由 deps 注入。
export function bootConfigState(deps) {
  const {
    SLANG_FILE, STATE_DIR, STICKER_FILE, fs, path, warmSelfIdentity,
    loadConfig, hardenStateDirAcl, acquireLock, loadState, loadSlang, loadStickerStore, log,
  } = deps;
  const cfg = loadConfig();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();
  loadState();
  // 预热 self_id / 昵称：SnowLuma 部分事件不带 self_id，唤醒判定要靠缓存兜底。
  // 异步执行、不阻塞启动；失败只影响「@ 能否唤醒」的兜底，所以不 await。
  void warmSelfIdentity();

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = [];
  // 读失败时（被占用 / 权限 / JSON 损坏）必须**暂停写入**：否则内存里的空数组
  // 会在下一次 saveSlangStore() 时覆盖掉磁盘上那份数据，学到的词条全丢。
  let slangStoreWritable = true;
  try {
    slangEntries = loadSlang(SLANG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });
  } catch (error) {
    slangStoreWritable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);
  }
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  // 库文件损坏/读不动时**不能当成空库继续**：下面任何一次 saveStickerStoreSafe 都会把
  // 「空库」写回去，把 AI 学到的 localNote/tags/usage 永久清零。读失败就显式降级为
  // 「只读不写」，并留下醒目日志（与 loadSlang 的 slangStoreWritable 同一套路）。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  // ── 一周滚动归档（旧版 /recall 关键词检索的能力迁移） ────────────────────
  // 每条收到的消息追加到 state/archive/<key>.jsonl，保留 ARCHIVE_DAYS 天（默认 7 天）。
  // 与 recentMessages（上限 100 条、会被清）不同，归档是 append-only，重启不丢。
  const ARCHIVE_DIR = path.join(STATE_DIR, 'archive');
  const ARCHIVE_DAYS = Number(cfg.archive?.days ?? 7);
  const ARCHIVE_RECALL_LIMIT = Number(cfg.archive?.recallLimit ?? 12);
  let archiveWritable = true;
  try {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  } catch {
    archiveWritable = false;
    log('⚠️ 归档目录创建失败，归档功能降级为关闭');
  }
  // @bridge-function archiveFileFor from archive-history
  // @bridge-function archiveAppend from archive-history
  // ── 消息永久库（SQLite + FTS5）：archiveAppend 里顺手落一条，检索走 message-db.js ──
  const MESSAGE_DB_FILE = path.join(STATE_DIR, "messages.db");
  let messageDbHandle = null;
  let messageDbBroken = false;
  // @bridge-function messageDb from archive-history

  /** 启动时回填：把已有 jsonl 归档与 social-v2 最近消息灌进库里（幂等，重复消息自动跳过）。 */
  // @bridge-function backfillMessageDb from archive-history

  /** 一次性迁移：早期回填把 key 写成了 group_123（文件名形态），修正为 group:123。 */
  // @bridge-function fixLegacyMessageKeys from archive-history

  /** 检索历史消息，供 qq_search_history 工具使用。 */
  // @bridge-function searchHistory from archive-history

  // 表情收集：按「图片字节 md5」去重（QQ 每条消息的 URL/文件名都不同，只能比内容）。
  const stickerSeenCounts = new Map(); // md5 -> 次数
  let stickerHashInFlight = 0;

  // @bridge-function collectByContentHash from incoming-media

  // 视频文件：下载 → 抽帧拼图 + 音轨转写 → 回填成一条可读消息。
  //
  // opts.autoClaim=false：引用视频路径用。转写结果是否「本轮已带上」由调用方判断并 claim；
  // 这类任务不参与 prompt 等待，也不会被自动标记已带上。
  const videoInFlight = new Set();
  // @bridge-function enrichVideoFile from incoming-media

  // @bridge-function maybeCollectSticker from incoming-media

  // @bridge-function archivePrune from incoming-media
  // 关键词检索归档：2 字滑窗 shingles 打分 + 时间倒序，返回最多 limit 条。
  // 打分与坏行容忍在 src/archive-search.js（纯函数，scripts/test-archive.mjs 覆盖）。
  // @bridge-function archiveRecall from incoming-media

  // @bridge-function stickerEnabled from stickers

  // @bridge-function saveStickerStoreSafe from stickers

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  return {
    get cfg() { return cfg; },
    get slangEntries() { return slangEntries; }, set slangEntries(v) { slangEntries = v; },
    get slangStoreWritable() { return slangStoreWritable; }, set slangStoreWritable(v) { slangStoreWritable = v; },
    get slangWindows() { return slangWindows; },
    get slangExtractionCooldowns() { return slangExtractionCooldowns; },
    get slangSubmitTimes() { return slangSubmitTimes; },
    get feedbackTimes() { return feedbackTimes; },
    get slangResearchingIds() { return slangResearchingIds; },
    get learnerSessions() { return learnerSessions; },
    get learnerCollectors() { return learnerCollectors; },
    get learnerWaiters() { return learnerWaiters; },
    get slangLearnerSessionId() { return slangLearnerSessionId; }, set slangLearnerSessionId(v) { slangLearnerSessionId = v; },
    get slangTaskChain() { return slangTaskChain; }, set slangTaskChain(v) { slangTaskChain = v; },
    get stickerEntries() { return stickerEntries; }, set stickerEntries(v) { stickerEntries = v; },
    get stickerStoreWritable() { return stickerStoreWritable; }, set stickerStoreWritable(v) { stickerStoreWritable = v; },
    get stickerSyncedAt() { return stickerSyncedAt; }, set stickerSyncedAt(v) { stickerSyncedAt = v; },
    get lastForcedAgentStickerSync() { return lastForcedAgentStickerSync; }, set lastForcedAgentStickerSync(v) { lastForcedAgentStickerSync = v; },
    get ARCHIVE_DIR() { return ARCHIVE_DIR; },
    get ARCHIVE_DAYS() { return ARCHIVE_DAYS; },
    get ARCHIVE_RECALL_LIMIT() { return ARCHIVE_RECALL_LIMIT; },
    get archiveWritable() { return archiveWritable; }, set archiveWritable(v) { archiveWritable = v; },
    get MESSAGE_DB_FILE() { return MESSAGE_DB_FILE; },
    get messageDbHandle() { return messageDbHandle; }, set messageDbHandle(v) { messageDbHandle = v; },
    get messageDbBroken() { return messageDbBroken; }, set messageDbBroken(v) { messageDbBroken = v; },
    get stickerSeenCounts() { return stickerSeenCounts; },
    get stickerHashInFlight() { return stickerHashInFlight; }, set stickerHashInFlight(v) { stickerHashInFlight = v; },
    get videoInFlight() { return videoInFlight; },
  };
}

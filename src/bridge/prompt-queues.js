// prompt-queues: extracted bridge responsibilities; no startup side effects.
// Live dependencies: promptQueues
export function createPromptQueues(deps) {
// @bridge-function drainPromptQueue:start
function drainPromptQueue(key, errorMsg) {
    const entry = deps.promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    deps.promptQueues.delete(key);
  }
// @bridge-function drainPromptQueue:end

// @bridge-function drainAllPromptQueues:start
function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of deps.promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    deps.promptQueues.clear();
  }
// @bridge-function drainAllPromptQueues:end
  return { drainPromptQueue, drainAllPromptQueues };
}

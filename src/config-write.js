// 配置写入的共享工具：**读盘再合并**，禁止用内存整份快照覆盖磁盘。
//
// 背景（2026-10-26 17:51 事故）：/api/model-routing 与 /api/model 以前直接
// `atomicWriteJson(config.json, cfg)` —— cfg 是启动时读进内存的整份对象。只要
// 期间有别的写入者（另一个 API、脚本、控制台保存）改过磁盘，这次写就把别人的
// 修改整段抹掉。现在统一走 `updateConfigFile()`：每次写之前重新读盘，在**磁盘
// 最新内容**上应用修改，再原子写。

import fs from 'node:fs';
import path from 'node:path';

/** 读 JSON 对象；不存在/损坏时返回空对象（写入方自行决定是否报错）。 */
export function readConfigObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 读盘 → 在最新内容上应用 mutate → 原子写。
 * @param {string} filePath config.json 路径
 * @param {(diskConfig: object) => (void|object)} mutate 直接修改传入对象；也可返回新对象
 * @param {{ atomicWrite: (file:string, obj:object)=>void }} deps 原子写实现（桥接里传 atomicWriteJson）
 * @returns {object} 实际写入的对象
 */
export function updateConfigFile(filePath, mutate, { atomicWrite } = {}) {
  if (typeof atomicWrite !== 'function') throw new Error('updateConfigFile 需要 atomicWrite 依赖');
  if (typeof mutate !== 'function') throw new Error('updateConfigFile 需要 mutate 函数');
  const disk = readConfigObject(filePath);
  const replaced = mutate(disk);
  const next = replaced && typeof replaced === 'object' ? replaced : disk;
  atomicWrite(filePath, next);
  return next;
}

/** 判断路径是否就是项目根下的真实 config.json。 */
export function isRealConfigPath(filePath, root) {
  const target = path.resolve(String(filePath));
  const real = path.resolve(String(root), 'config.json');
  return target === real;
}

/**
 * 脚本写 config 的保护：**真实 config.json 默认拒绝写**，只有显式设置
 * QQ_BRIDGE_ALLOW_CONFIG_WRITE=1 才放行；临时目录/其他文件名不受限。
 * @throws {Error} 不允许时抛出（附带怎么解开的说明）
 */
export function assertScriptConfigWriteAllowed(filePath, { root, env = process.env } = {}) {
  if (!isRealConfigPath(filePath, root)) return true;
  if (String(env?.QQ_BRIDGE_ALLOW_CONFIG_WRITE || '') === '1') return true;
  throw new Error(
    `拒绝写真实 config.json（${path.resolve(String(filePath))}）：脚本默认只能写临时目录。` +
    '确实需要时显式设置 QQ_BRIDGE_ALLOW_CONFIG_WRITE=1。'
  );
}

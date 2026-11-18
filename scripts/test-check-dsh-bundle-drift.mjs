// test-check-dsh-bundle-drift.mjs — 给 check-dsh-bundle-drift.mjs 做的回归。
//
// 为什么单独测这个只读脚本：它的价值全在"判定口径"——把复制件判成 link 会放过
// 白名单旧插件事故，把 junction 判成 copy 会天天误报，没人再信它。这些判定不能
// 靠肉眼在真机上试，所以用临时 ~/.dsh 造出四种形态（空 / 复制件 / 链接 / 错链接）
// 逐个断言退出码、status、staleFiles 与 findings 的可读性。
//
// 临时 home 一律建在 os.tmpdir()：仓库 state/ 有 ACL 限制，不能当测试夹具。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'check-dsh-bundle-drift.mjs');
const REPO_BUNDLE = path.join(ROOT, 'plugins', 'qq-agent-presets');

/** 跑一次自检脚本；--json 拿结构化结果，退出码额外返回。 */
function runCheck(home, extraArgs = []) {
  const result = spawnSync(process.execPath, [SCRIPT, '--home', home, '--json', ...extraArgs], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, `脚本没能启动：${result.error?.message}`);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    assert.fail(`输出不是 JSON（stderr=${result.stderr}），stdout=${result.stdout.slice(0, 500)}`);
  }
  return { code: result.status, payload };
}

/** 建一个临时 DSH_HOME；返回 {home, cleanup}，用例结束必须清理。 */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-drift-home-'));
  return {
    home,
    cleanup() {
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function bundleOf(payload, name) {
  const found = payload.bundles.find((b) => b.name === name);
  assert.ok(found, `输出里没有 ${name}：${JSON.stringify(payload)}`);
  return found;
}

test('空 home：两个 bundle 都是 missing，退出码 0', () => {
  const { home, cleanup } = makeHome();
  try {
    const { code, payload } = runCheck(home);
    assert.equal(code, 0, `空 home 应视为未安装：${JSON.stringify(payload)}`);
    assert.equal(payload.ok, true);
    assert.equal(payload.home, path.resolve(home));
    for (const name of ['qq-agent-presets', 'qq-mode-console']) {
      const bundle = bundleOf(payload, name);
      assert.equal(bundle.status, 'missing');
      assert.deepEqual(bundle.staleFiles, []);
    }
  } finally {
    cleanup();
  }
});

test('普通目录复制件：判 copy、列出 staleFiles、退出码 1', () => {
  const { home, cleanup } = makeHome();
  try {
    const installDir = path.join(home, 'plugins', 'qq-agent-presets');
    fs.mkdirSync(installDir, { recursive: true });
    // package.json 是仓库 bundle 里真实存在的文件，写一份不同内容即可稳定造出漂移。
    fs.writeFileSync(path.join(installDir, 'package.json'), '{"name":"stale-copy"}\n', 'utf8');

    const { code, payload } = runCheck(home);
    assert.equal(code, 1, `复制件必须报漂移：${JSON.stringify(payload)}`);
    assert.equal(payload.ok, false);
    const bundle = bundleOf(payload, 'qq-agent-presets');
    assert.equal(bundle.status, 'copy');
    assert.ok(bundle.staleFiles.includes('package.json'), `staleFiles=${bundle.staleFiles}`);
    assert.ok(bundle.staleFiles.length <= 5, '不一致文件最多列 5 个');
    // 未安装的那个仍然算 missing，不该被顺带报成漂移。
    assert.equal(bundleOf(payload, 'qq-mode-console').status, 'missing');
  } finally {
    cleanup();
  }
});

test('junction 指向仓库 bundle：判 link、退出码 0', (t) => {
  const { home, cleanup } = makeHome();
  try {
    const installDir = path.join(home, 'plugins', 'qq-agent-presets');
    fs.mkdirSync(path.dirname(installDir), { recursive: true });
    try {
      fs.symlinkSync(REPO_BUNDLE, installDir, 'junction');
    } catch (e) {
      t.skip(`当前环境建不了 junction（${e.code ?? e.message}）`);
      return;
    }

    const { code, payload } = runCheck(home);
    assert.equal(code, 0, `链接是正常形态：${JSON.stringify(payload)}`);
    const bundle = bundleOf(payload, 'qq-agent-presets');
    assert.equal(bundle.status, 'link');
    assert.equal(
      path.resolve(bundle.target).toLowerCase(),
      path.resolve(fs.realpathSync(REPO_BUNDLE)).toLowerCase(),
      'target 应指向仓库 plugins/qq-agent-presets',
    );
    assert.deepEqual(bundle.staleFiles, []);
  } finally {
    cleanup();
  }
});

test('链接指向别处：判 link-wrong-target、退出码 1', (t) => {
  const { home, cleanup } = makeHome();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-drift-other-'));
  try {
    const installDir = path.join(home, 'plugins', 'qq-mode-console');
    fs.mkdirSync(path.dirname(installDir), { recursive: true });
    try {
      fs.symlinkSync(other, installDir, 'junction');
    } catch (e) {
      t.skip(`当前环境建不了 junction（${e.code ?? e.message}）`);
      return;
    }

    const { code, payload } = runCheck(home);
    assert.equal(code, 1, `错链接必须报漂移：${JSON.stringify(payload)}`);
    assert.equal(bundleOf(payload, 'qq-mode-console').status, 'link-wrong-target');
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
    cleanup();
  }
});

test('输出形状：JSON 可解析、findings 是中文句子数组', () => {
  const { home, cleanup } = makeHome();
  try {
    const { payload } = runCheck(home);
    assert.ok(Array.isArray(payload.findings) && payload.findings.length >= 2);
    for (const line of payload.findings) {
      assert.equal(typeof line, 'string');
      assert.match(line, /[\u4e00-\u9fa5]/, `findings 应为中文：${line}`);
    }
    // 位置参数只查指定 bundle（测试要确认 CLI 这点，不然回归里会漏查一个）。
    const { payload: one } = runCheck(home, ['qq-mode-console']);
    assert.equal(one.bundles.length, 1);
    assert.equal(one.bundles[0].name, 'qq-mode-console');
  } finally {
    cleanup();
  }
});

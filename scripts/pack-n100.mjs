// 打包 N100 降级版：scripts/pack-n100.mjs
// 用法：node scripts/pack-n100.mjs [--with-models] [--with-live2d] [--with-deps] [--out ..\dist-n100]
//
// 产物：
//   <out>/qq-bridge-n100/          可直接拷贝到目标机器
//   <out>/qq-bridge-n100-<日期>.zip  压缩包（方便发给朋友）
//
// 原则：只带代码 + 模板 + 文档 + 启动脚本；
//      不带 state/（原机数据）、node_modules/、data/（可选模型）、临时脚本、备份配置。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const withModels = argv.includes('--with-models');
const withDeps = argv.includes('--with-deps');   // 连 node_modules 一起带（离线目标机免 npm install，约 +290MB）
const withLive2d = argv.includes('--with-live2d');
const outArg = argv.indexOf('--out');
const OUT_ROOT = path.resolve(ROOT, outArg >= 0 ? argv[outArg + 1] : '../dist-n100');
const NAME = 'qq-bridge-n100';
const DEST = path.join(OUT_ROOT, NAME);

const log = (...a) => console.log(...a);
const rmrf = (p) => { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); };

// ---------- 1. 清空输出目录 ----------
rmrf(DEST);
fs.mkdirSync(DEST, { recursive: true });

// ---------- 2. 复制目录（带排除规则） ----------
const skipDir = new Set(['state', 'node_modules', 'oil-ui-work', '.git', 'logs', 'delivery', 'dist', 'desktop', 'archive', 'audio', 'dsh', 'plugins']);
const skipFileRe = [
  /^config\.json$/,              // 原机配置（含 key）
  /^config\..*\.bak/,            // 备份配置
  /^config\.json\.bak/,          // 备份配置
  /^config\.template\.json$/,
  /^config\.test\.json$/,        // 测试配置
  /^start\.bat\.bak/,            // 旧脚本备份
  /\.bak-[0-9]+$/,                // 任何 .bak-日期 备份
  /^_tmp_/,                      // 临时脚本
  /^live2d-test\.png$/,
  /^_shot-.*\.png$/,          // 开发期截图
  /\.bak($|[-.])/,              // 任何 .bak 备份（.bak / .bak-日期 / .bak-ui …）
  /^_snowluma-catalog\.json$/,
  /^REFACTOR-/,                  // 重构过程文件
  /\.log$/,
];

function copyTree(src, destRel) {
  const dest = path.join(DEST, destRel);
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, e.name);
    const dp = path.join(dest, e.name);
    if (e.isDirectory()) {
      if (skipDir.has(e.name)) continue;
      if (destRel === '' && e.name === 'data') continue; // data 单独处理
      n += copyTree(sp, path.join(destRel, e.name));
    } else {
      if (skipFileRe.some((re) => re.test(e.name))) continue;
      fs.copyFileSync(sp, dp);
      n += 1;
    }
  }
  return n;
}

const copied = copyTree(ROOT, '');
log(`✔ 代码与资源：${copied} 个文件`);

// ---------- 3. 配置模板 ----------
const cfgSrc = path.join(ROOT, 'config.n100.example.json');
if (!fs.existsSync(cfgSrc)) {
  console.error('✘ 缺少 config.n100.example.json，先跑一次生成脚本');
  process.exit(1);
}
fs.copyFileSync(cfgSrc, path.join(DEST, 'config.n100.example.json'));
log('✔ 配置模板 config.n100.example.json');

// 启动脚本 + 文档
for (const f of ['start-n100.ps1']) {
  if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(DEST, f));
}
const deployDoc = path.join(ROOT, 'docs/N100-DEPLOY.md');
if (fs.existsSync(deployDoc)) {
  fs.mkdirSync(path.join(DEST, 'docs'), { recursive: true });
  fs.copyFileSync(deployDoc, path.join(DEST, 'docs/N100-DEPLOY.md'));
  fs.copyFileSync(deployDoc, path.join(DEST, 'N100-DEPLOY.md'));
}
log('✔ 启动脚本与部署文档');

// ---------- 3.5 黑话梗库（查梗功能要用，16MB） ----------
{
  const db = path.join(ROOT, 'data/memewiki.db');
  if (fs.existsSync(db)) {
    fs.mkdirSync(path.join(DEST, 'data'), { recursive: true });
    fs.copyFileSync(db, path.join(DEST, 'data/memewiki.db'));
    log('✔ 已带上黑话梗库 data/memewiki.db');
  }
}

// ---------- 4. 可选：embedding 模型 ----------
if (withModels) {
  // 只带 config.n100.example.json 里同时声明的那个模型（bge-small，22MB）；
  // 开发机上还留着试过的 bge-base（98MB），那个不进包。
  const wanted = new Set(['bge-small-zh-v1.5']);
  const src = path.join(ROOT, 'data/models');
  if (fs.existsSync(src)) {
    let total = 0;
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      for (const vendor of fs.readdirSync(path.join(src, e.name), { withFileTypes: true })) {
        if (!vendor.isDirectory() || !wanted.has(vendor.name)) continue;
        copyTree(path.join(src, e.name, vendor.name), path.join('data/models', e.name, vendor.name));
        total++;
      }
    }
    log(`✔ 已带上 embedding 模型（${total} 个，约 23MB，免首次下载）`);
  } else {
    log('⚠ data/models 不存在，跳过（目标机首次启动会自动下载）');
  }
} else {
  log('· 未带 embedding 模型（目标机首次启动自动下载约 23MB；离线部署加 --with-models）');
}

// ---------- 4.5 可选：node_modules（离线部署用） ----------
if (withDeps) {
  const nmSrc = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nmSrc)) {
    log('⚠ node_modules 不存在，跳过（目标机需 npm install --omit=dev）');
  } else {
    // 目标机是 Windows x64：onnxruntime 的 darwin/linux 预编译二进制（141MB）用不上
    // 路径统一成 / 再判断（Windows 反斜杠别写进正则，容易转义踩坑）
    const shouldDrop = (rp) => {
      const u = rp.split(path.sep).join('/');
      return /onnxruntime-node\/bin\/napi-v3\/(darwin|linux)\//.test(u) || u.endsWith('/napi-v3/darwin') || u.endsWith('/napi-v3/linux');
    };
    let bytes = 0, files = 0;
    const walk = (from, rel) => {
      const to = path.join(DEST, rel);
      fs.mkdirSync(to, { recursive: true });
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const sp = path.join(from, e.name);
        const rp = path.join(rel, e.name);
        if (shouldDrop(rp)) continue;
        if (e.isDirectory()) walk(sp, rp);
        else {
          fs.copyFileSync(sp, path.join(DEST, rp));
          bytes += fs.statSync(sp).size;
          files++;
        }
      }
    };
    walk(nmSrc, 'node_modules');
    log(`✔ 已带上 node_modules（${files} 个文件，${(bytes / 1048576).toFixed(0)}MB，已裁掉 darwin/linux 二进制）`);
  }
} else {
  log('· 未带 node_modules（目标机执行 npm install --omit=dev，实测约 5 秒；离线目标机加 --with-deps）');
}

// ---------- 5. 可选：Live2D ----------
if (withLive2d) {
  const src = path.join(ROOT, 'data/live2d');
  if (fs.existsSync(src)) {
    copyTree(src, 'data/live2d');
    log('✔ 已带上 Live2D 模型与运行库');
  }
} else {
  log('· 未带 Live2D（N100 上默认关闭，需要再加 --with-live2d）');
}

// ---------- 6. 空 state 目录（首次启动会自动建） ----------
fs.mkdirSync(path.join(DEST, 'state'), { recursive: true });
fs.writeFileSync(path.join(DEST, 'state', '.gitkeep'), '');

// ---------- 7. 依赖清单自检 ----------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const mustHave = ['@huggingface/transformers'];
const missing = mustHave.filter((d) => !(pkg.dependencies || {})[d]);
if (missing.length) log(`⚠ package.json 缺少依赖：${missing.join(', ')}（语义检索会退化为关键词）`);
else log('✔ package.json 依赖齐全（npm install --omit=dev 即可）');

// ---------- 8. 打 zip ----------
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const zipPath = path.join(OUT_ROOT, `${NAME}-${stamp}.zip`);
rmrf(zipPath);
try {
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${DEST}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`
  ], { stdio: 'pipe' });
  const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  log(`✔ 压缩包：${zipPath}（${mb} MB）`);
} catch (e) {
  log(`⚠ 打包 zip 失败：${e.message}（目录内容已就绪，可手动压缩）`);
}

// ---------- 9. 汇总 ----------
const size = (p) => {
  let s = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else s += fs.statSync(f).size;
    }
  };
  walk(p);
  return (s / 1024 / 1024).toFixed(1);
};
log('');
log('=== 打包完成 ===');
log(`目录：${DEST}（${size(DEST)} MB）`);
log('目标机器上：解压 → 复制 config.n100.example.json 为 config.json → 填配置 → npm install --omit=dev → 双击 start-n100.ps1');

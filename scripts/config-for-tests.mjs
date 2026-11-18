// 测试用配置解析（D64）：解决「工作树没有 config.json（禁写区）→ 三个套件永远红」。
// 优先级：QQ_BRIDGE_TEST_CONFIG > <root>/config.json > <root>/config.test.json
//   * 环境变量：显式指定，路径可绝对也可相对仓库根；给 CI/临时 fixture 用。
//   * config.json：线上/主仓库的真配置，行为与拆分前完全一致（存在就用它）。
//   * config.test.json：仓库自带的脱敏占位配置，只在真的没有 config.json（工作树）时兜底。
// 本模块只被测试/维护脚本使用；bridge 运行时读配置的逻辑一行没改。
import fs from 'node:fs';
import path from 'node:path';

export const TEST_CONFIG_ENV = 'QQ_BRIDGE_TEST_CONFIG';

/** 只读环境变量：设了就返回绝对路径（不存在也不含糊，交给调用方报错），没设返回 ''。 */
export function testConfigFromEnv(root) {
  const fromEnv = String(process.env[TEST_CONFIG_ENV] || '').trim();
  if (!fromEnv) return '';
  return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(root, fromEnv);
}

/** 返回当前应读取的配置文件绝对路径；都不存在时抛错并说明三种来源。 */
export function resolveTestConfigPath(root) {
  const fromEnv = testConfigFromEnv(root);
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      throw new Error(`${TEST_CONFIG_ENV}=${process.env[TEST_CONFIG_ENV]} 指向的配置文件不存在：${fromEnv}`);
    }
    return fromEnv;
  }
  const real = path.join(root, 'config.json');
  if (fs.existsSync(real)) return real;
  const fixture = path.join(root, 'config.test.json');
  if (fs.existsSync(fixture)) return fixture;
  throw new Error(`找不到配置文件：${real} 不存在，${fixture} 也不存在，且未设置 ${TEST_CONFIG_ENV}`);
}

/** 读并解析配置（容忍 BOM）；返回 { path, config }。 */
export function readTestConfig(root) {
  const file = resolveTestConfigPath(root);
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { path: file, config: JSON.parse(text) };
}

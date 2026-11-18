// Send a one-off group message through the local bridge's identity/whitelist guards.
// This script never connects directly to SnowLuma. Sending requires an explicit --confirm flag.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const positional = args.filter((arg) => arg !== '--confirm');
const [groupIdRaw, ...messageParts] = positional;
const groupId = String(groupIdRaw ?? '');
const message = messageParts.join(' ').trim();
const base = process.env.QQ_BRIDGE_URL || 'http://127.0.0.1:3100';

function localBridgeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('QQ_BRIDGE_URL is invalid'); }
  const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'http:' || !isLocal || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Only a local bridge root URL is allowed');
  }
  return url.origin;
}

async function main() {
  if (!/^\d{5,20}$/.test(groupId)) throw new Error('Usage: node scripts/send-test-group.mjs <explicit-group-id> <message> [--confirm]');
  if (!message) throw new Error('An explicit non-empty message is required');
  const endpoint = `${localBridgeUrl(base)}/api/test-send`;
  const tokenPath = path.join(root, 'state', 'console-token');
  if (!fs.existsSync(tokenPath)) throw new Error('Local bridge console token is unavailable');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (!token) throw new Error('Local bridge console token is empty');

  if (!confirm) {
    console.log(JSON.stringify({ mode: 'dry-run', endpoint, kind: 'group', groupId, messageChars: message.length, sendRequires: '--confirm' }, null, 2));
    return;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({ kind: 'group', id: Number(groupId), message }),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok !== true) throw new Error(`Bridge rejected test send (HTTP ${response.status}): ${result?.error ?? 'unknown error'}`);
  console.log(JSON.stringify({ ok: true, kind: 'group', groupId, message_id: result.message_id }));
}

main().catch((error) => {
  console.error(`send-test-group: ${error?.message ?? error}`);
  process.exitCode = 1;
});

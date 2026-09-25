#!/usr/bin/env node
/* Smoke test: spawns the MCP server over stdio and drives the JSON-RPC
 * handshake — initialize -> tools/list -> (if a token is present) cf_verify.
 * No secrets required to pass the transport checks; cf_verify is skipped
 * gracefully when CLOUDFLARE_API_TOKEN is unset.
 *
 *   node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'index.mjs');
const hasToken = !!(process.env.CLOUDFLARE_API_TOKEN);

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });

const pending = new Map();
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

let idSeq = 0;
function rpc(method, params) {
  const id = ++idSeq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function assert(cond, label) {
  if (!cond) { console.error(`✗ ${label}`); child.kill(); process.exit(1); }
  console.log(`✓ ${label}`);
}

const run = async () => {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert(init.result?.serverInfo?.name === 'cloudflare-mcp', 'initialize returns serverInfo');

  const list = await rpc('tools/list', {});
  const tools = list.result?.tools || [];
  assert(tools.length === 8, `tools/list exposes 8 tools (got ${tools.length})`);
  assert(tools.some((t) => t.name === 'cf_request'), 'universal cf_request tool present');
  assert(tools.some((t) => t.name === 'cf_dns_delete'), 'gated cf_dns_delete tool present');

  if (hasToken) {
    const verify = await rpc('tools/call', { name: 'cf_verify', arguments: {} });
    const text = verify.result?.content?.[0]?.text || '';
    assert(/"ok":\s*true|"status":\s*"active"/.test(text), 'cf_verify succeeds with live token');
  } else {
    console.log('• CLOUDFLARE_API_TOKEN not set — skipping live cf_verify (transport checks passed)');
  }

  console.log('\nSmoke test passed.');
  child.kill();
  process.exit(0);
};

run().catch((e) => { console.error(e); child.kill(); process.exit(1); });

setTimeout(() => { console.error('✗ timeout — server did not respond'); child.kill(); process.exit(1); }, 10000);

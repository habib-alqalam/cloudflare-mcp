#!/usr/bin/env node
/*
 * cloudflare-mcp — Model Context Protocol server for Cloudflare (stdio, JSON-RPC 2.0).
 *
 * Typed tools for DNS, zones, and cache, plus cf_request as a universal
 * passthrough to any Cloudflare API v4 endpoint. Destructive operations
 * (record delete, purge-everything) require {"confirm": true}.
 *
 * Zero dependencies. Single file. Node 18+ (global fetch).
 *
 * Config (environment or local .env):
 *   CLOUDFLARE_API_TOKEN   required
 *   CLOUDFLARE_ACCOUNT_ID  optional — scopes cf_list_zones to one account
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://api.cloudflare.com/client/v4';

// --- credential loading -------------------------------------------------
// Precedence: real process env > .env in cwd > .env next to this file.
// Kept dependency-free on purpose (no dotenv).
function parseEnvFile(file) {
  const cfg = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) cfg[m[1]] = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env — fine */ }
  return cfg;
}
function loadCreds() {
  const fromFiles = {
    ...parseEnvFile(path.resolve(__dirname, '.env')),
    ...parseEnvFile(path.resolve(process.cwd(), '.env')),
  };
  const pick = (k) => process.env[k] || fromFiles[k];
  return {
    token: pick('CLOUDFLARE_API_TOKEN'),
    account: pick('CLOUDFLARE_ACCOUNT_ID'),
  };
}
const CREDS = loadCreds();

// --- Cloudflare API v4 fetch wrapper -----------------------------------
async function cf(method, p, { query, body } = {}) {
  if (!CREDS.token) return { success: false, error: 'CLOUDFLARE_API_TOKEN is not set (env or .env)' };
  let url = BASE + (p.startsWith('/') ? p : '/' + p);
  if (query && Object.keys(query).length) {
    const q = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== ''));
    if (Object.keys(q).length) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(q);
  }
  const headers = { Authorization: `Bearer ${CREDS.token}`, Accept: 'application/json' };
  const opts = { method: method || 'GET', headers };
  if (body !== undefined && (method && method !== 'GET')) {
    headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 1500) }; }
  return { http_status: res.status, ok: res.ok, ...(data && typeof data === 'object' ? data : { data }) };
}

// resolve a zone name → zone id (cached per process)
const _zoneCache = {};
async function zoneId(zone) {
  if (!zone) throw new Error('zone (domain) required');
  if (/^[0-9a-f]{32}$/.test(zone)) return zone;           // already an id
  if (_zoneCache[zone]) return _zoneCache[zone];
  const r = await cf('GET', '/zones', { query: { name: zone } });
  const id = r.result && r.result[0] && r.result[0].id;
  if (!id) throw new Error(`zone not found: ${zone}`);
  _zoneCache[zone] = id;
  return id;
}

const GUARD = 'Destructive — pass {"confirm": true} to proceed.';
const TOOLS = [
  { name:'cf_request', description:'Call ANY Cloudflare API v4 endpoint. Universal. path e.g. "/zones", "/zones/{id}/dns_records". Use for anything not covered below.', inputSchema:{type:'object',required:['path'],properties:{method:{type:'string',enum:['GET','POST','PUT','PATCH','DELETE']},path:{type:'string'},query:{type:'object',additionalProperties:true},body:{type:'object',additionalProperties:true}}} },
  { name:'cf_verify',   description:'Verify the API token (status + which it is).', inputSchema:{type:'object',properties:{}} },
  { name:'cf_list_zones', description:'List all zones (domains) with their ids and status.', inputSchema:{type:'object',properties:{}} },
  { name:'cf_dns_list', description:'List DNS records for a zone (zone = domain name or zone id).', inputSchema:{type:'object',required:['zone'],properties:{zone:{type:'string'},type:{type:'string'},name:{type:'string'}}} },
  { name:'cf_dns_create', description:'Create a DNS record. Then re-read with cf_dns_list to verify.', inputSchema:{type:'object',required:['zone','type','name','content'],properties:{zone:{type:'string'},type:{type:'string'},name:{type:'string'},content:{type:'string'},ttl:{type:'number',description:'1=auto'},proxied:{type:'boolean'},priority:{type:'number'}}} },
  { name:'cf_dns_update', description:'Update a DNS record by id (PATCH; only pass fields to change).', inputSchema:{type:'object',required:['zone','id'],properties:{zone:{type:'string'},id:{type:'string'},type:{type:'string'},name:{type:'string'},content:{type:'string'},ttl:{type:'number'},proxied:{type:'boolean'}}} },
  { name:'cf_dns_delete', description:'Delete a DNS record by id (gated).', inputSchema:{type:'object',required:['zone','id'],properties:{zone:{type:'string'},id:{type:'string'},confirm:{type:'boolean'}}} },
  { name:'cf_purge_cache', description:'Purge cache for a zone. {everything:true} gated by confirm; or files:[urls].', inputSchema:{type:'object',required:['zone'],properties:{zone:{type:'string'},everything:{type:'boolean'},files:{type:'array',items:{type:'string'}},confirm:{type:'boolean'}}} },
];

async function dispatch(name, a = {}) {
  switch (name) {
    case 'cf_request':     return cf(a.method || 'GET', a.path, { query: a.query, body: a.body });
    case 'cf_verify':      return cf('GET', '/user/tokens/verify');
    case 'cf_list_zones':  return cf('GET', '/zones', { query: { per_page: 50, ...(CREDS.account ? { 'account.id': CREDS.account } : {}) } });
    case 'cf_dns_list':    return cf('GET', `/zones/${await zoneId(a.zone)}/dns_records`, { query: { type: a.type, name: a.name, per_page: 100 } });
    case 'cf_dns_create':  return cf('POST', `/zones/${await zoneId(a.zone)}/dns_records`, { body: { type:a.type, name:a.name, content:a.content, ttl:a.ttl ?? 1, proxied:a.proxied ?? false, ...(a.priority!=null?{priority:a.priority}:{}) } });
    case 'cf_dns_update':  return cf('PATCH', `/zones/${await zoneId(a.zone)}/dns_records/${a.id}`, { body: Object.fromEntries(['type','name','content','ttl','proxied'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]])) });
    case 'cf_dns_delete':  return a.confirm === true ? cf('DELETE', `/zones/${await zoneId(a.zone)}/dns_records/${a.id}`) : { refused: GUARD };
    case 'cf_purge_cache': {
      if (a.everything && a.confirm !== true) return { refused: GUARD + ' (purge everything)' };
      const body = a.everything ? { purge_everything: true } : { files: a.files || [] };
      return cf('POST', `/zones/${await zoneId(a.zone)}/purge_cache`, { body });
    }
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// --- MCP stdio JSON-RPC 2.0 transport ----------------------------------
const SERVER_NAME = 'cloudflare-mcp';
const SERVER_VERSION = '1.0.0';
function send(m){ process.stdout.write(JSON.stringify(m)+'\n'); }
function reply(id,result){ send({ jsonrpc:'2.0', id, result }); }
function fail(id,code,message){ send({ jsonrpc:'2.0', id, error:{ code, message } }); }
async function handle(msg){
  const { id, method, params } = msg;
  if (method === 'initialize') return reply(id,{ protocolVersion: params?.protocolVersion||'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:SERVER_NAME, version:SERVER_VERSION} });
  if (method === 'notifications/initialized') return;
  if (method === 'ping') return reply(id,{});
  if (method === 'tools/list') return reply(id,{ tools: TOOLS });
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    try { const data = await dispatch(name, args); const isError = data && (data.ok === false || data.success === false || data.error || data.refused); return reply(id,{ content:[{type:'text',text:JSON.stringify(data,null,2)}], isError: !!isError }); }
    catch (e) { return reply(id,{ content:[{type:'text',text:`ERROR: ${e.message}`}], isError:true }); }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}
let buf='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',(c)=>{ buf+=c; let nl; while((nl=buf.indexOf('\n'))>=0){ const line=buf.slice(0,nl).trim(); buf=buf.slice(nl+1); if(!line)continue; let m; try{m=JSON.parse(line)}catch{continue} handle(m).catch(e=>process.stderr.write(`[${SERVER_NAME}] ${e.stack}\n`)); } });
process.stderr.write(`[${SERVER_NAME}] MCP ready (token: ${CREDS.token?'set':'MISSING'})\n`);

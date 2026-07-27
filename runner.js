#!/usr/bin/env node
// cc-runner: 本地任务守护进程(pull 模型,纯中心化)。走 runner 专属通道 runner-api,
// 每次请求带 X-Runner-Token(令牌即身份,服务器据此认出是哪台 runner)。
//
// 中心化:runner 不做任何本地自主调度。**所有要执行的任务(webhook / 手动 / 定时)
// 一律由服务器生成为待领队列,runner 先 /claim 领到才执行** —— 不在本地算 cron、
// 不离线自跑。断网就是纯粹拉不到任务,恢复后继续领。
//
// 四个操作,全部 POST:
//   /heartbeat  每 30s 打卡,返回 { schedulesVersion }
//   /sync       版本变了拉本机定时任务定义(仅本地缓存供 status 展示,不驱动执行)
//   /claim      领一条待执行任务,返回 { job } 或 { job: null }
//   /report     回报结果 { jobId, status, exitCode, summary, error, startedAt, finishedAt }
//               只能改自己领走的那条(服务器校验)
//
// 结果先写本地 outbox 再上报 /report,断线累积、恢复补传。
// 零 npm 依赖:Node >= 18(需要全局 fetch)。入口是 bin/cli.js(cc-runner start)。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// 配置与状态
// ---------------------------------------------------------------------------
const HOME_DIR = process.env.CC_RUNNER_HOME || path.join(os.homedir(), '.cc-runner');
const CONFIG_PATH = process.env.CC_RUNNER_CONFIG || path.join(HOME_DIR, 'config.json');
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {
  console.error(`[fatal] 读不到配置 ${CONFIG_PATH},先跑: cc-runner init --api <runner-api地址> --token <X-Runner-Token>`);
  process.exit(1);
}
for (const k of ['api_url', 'runner_token']) {
  if (!cfg[k]) { console.error(`[fatal] config 缺少 ${k}(旧版 cloud_url/service_key 已废弃,请重新 cc-runner init)`); process.exit(1); }
}
const API_BASE = cfg.api_url.replace(/\/$/, '');
let runnerId = cfg.runner_id || 'default'; // 本地标签;首次 heartbeat 后用服务器返回的真实值覆盖
let orgName = '';
const POLL_MS = (cfg.poll_interval_seconds || 30) * 1000;
const CLAUDE_BIN = cfg.claude_bin || 'claude';
const CLAUDE_ARGS = cfg.claude_args || ['--dangerously-skip-permissions'];
const MODEL = cfg.model || '';
// 云端下发的 workdir 常含字面量 ~(平台 UI 里用户自然会填 ~/xxx),path.resolve 不认
// ~,会拼成 <cwd>/~/xxx。这里统一把开头的 ~ 展开成 home,再交给 resolve/白名单/spawn。
function expandTilde(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
const ALLOWED_WORKDIRS = (cfg.allowed_workdirs || []).map((p) => path.resolve(expandTilde(p)));
const JOB_PULL_LIMIT = cfg.job_pull_limit || 20; // 每轮最多 /claim 多少条,防一次拉太多

const DATA_DIR = path.join(HOME_DIR, 'data');
const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');
const TRANSCRIPT_DIR = path.join(DATA_DIR, 'transcripts');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
for (const d of [DATA_DIR, OUTBOX_DIR, TRANSCRIPT_DIR]) fs.mkdirSync(d, { recursive: true });

// state = { schedule_version, schedules: [](仅缓存展示), done: {"<dedup_key>": {status, at}}, outbox_seq }
let state = { schedule_version: -1, schedules: [], done: {}, outbox_seq: 0 };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; } catch (_) { /* 首次运行 */ }

function saveState() {
  const keys = Object.keys(state.done);
  if (keys.length > 5000) {
    keys.sort((a, b) => (state.done[a].at < state.done[b].at ? -1 : 1));
    for (const k of keys.slice(0, keys.length - 5000)) delete state.done[k];
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}

function log(msg) { console.log(`${new Date().toISOString()} ${msg}`); }

// ---------------------------------------------------------------------------
// runner-api 调用(POST + X-Runner-Token)
//   抛出的 error 带 .retriable:网络错误/5xx 可重试;4xx/{error} 视为永久失败。
// ---------------------------------------------------------------------------
async function api(op, body) {
  let res;
  try {
    res = await fetch(`${API_BASE}/${op}`, {
      method: 'POST',
      headers: { 'X-Runner-Token': cfg.runner_token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    const err = new Error(`${op} 网络错误: ${e.message}`); err.retriable = true; throw err;
  }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) { /* 非 JSON */ }
  if (!res.ok || (data && data.error)) {
    const msg = (data && data.error) ? data.error : `${res.status} ${text.slice(0, 200)}`;
    const err = new Error(`${op} -> ${msg}`); err.retriable = res.status >= 500; throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// 心跳拿版本 + 定时任务定义同步(仅缓存,供 status 展示;执行一律走 /claim)
// ---------------------------------------------------------------------------
async function heartbeat() {
  const r = await api('heartbeat');
  if (r && r.runner) runnerId = r.runner;
  if (r && r.orgName) orgName = r.orgName;
  return r && r.schedulesVersion != null ? Number(r.schedulesVersion) : null;
}

async function syncSchedules() {
  const r = await api('sync');
  state.schedules = Array.isArray(r && r.schedules) ? r.schedules : [];
  if (r && r.version != null) state.schedule_version = Number(r.version);
  saveState();
  log(`[sync] 定时任务版本 ${state.schedule_version},清单 ${state.schedules.length} 条(仅缓存,执行走 /claim)`);
}

// ---------------------------------------------------------------------------
// 领取任务队列(服务器原子认领,逐条领到空为止)。webhook / 手动 / 定时 都在这。
// ---------------------------------------------------------------------------
async function claimJobs() {
  const items = [];
  for (let i = 0; i < JOB_PULL_LIMIT; i++) {
    const r = await api('claim');
    const job = r && r.job;
    if (!job) break; // 队列空
    items.push({
      dedupKey: job.dedup_key || `job:${job.id}`, source: job.source || 'webhook', jobId: job.id,
      scheduledAt: job.scheduled_at || job.created_at,
      name: job.source === 'webhook' ? `webhook:${job.trigger_id || ''}` : (job.source || 'job'),
      prompt: job.prompt, workdir: expandTilde(job.workdir),
      timeoutSeconds: job.timeout_seconds || 900, output: job.output || {},
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
function workdirAllowed(dir) {
  if (!ALLOWED_WORKDIRS.length) return false; // 白名单空 = 全拒,安全兜底本地说了算
  const r = path.resolve(dir || '');
  return ALLOWED_WORKDIRS.some((w) => r === w || r.startsWith(w + path.sep));
}

function runClaude(item, runId) {
  return new Promise((resolve) => {
    const args = ['-p', item.prompt, '--output-format', 'json', ...CLAUDE_ARGS];
    if (MODEL) args.push('--model', MODEL);
    const timeoutMs = item.timeoutSeconds * 1000;
    const child = spawn(CLAUDE_BIN, args, { cwd: item.workdir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let errOut = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d.toString().slice(0, 4000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: 'failed', error: `spawn 失败: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(TRANSCRIPT_DIR, `${runId}.json`), out || errOut || '');
      if (timedOut) return resolve({ status: 'timeout', error: `超时(${timeoutMs / 1000}s)强杀`, exitCode: code });
      let summary = '';
      try { summary = String(JSON.parse(out).result || '').slice(0, 4000); } catch (_) { summary = (out || '').slice(0, 4000); }
      if (code !== 0) return resolve({ status: 'failed', exitCode: code, summary, error: errOut.slice(0, 1000) });
      resolve({ status: 'success', exitCode: 0, summary });
    });
  });
}

async function notifyFeishu(item, run) {
  const url = (item.output && item.output.feishu_webhook) || cfg.default_feishu_webhook;
  if (!url) return;
  const icon = { success: '✅', failed: '❌', timeout: '⏱️', rejected: '🚫' }[run.status] || '•';
  const body = {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: `${icon} [${run.status}] ${item.name}` },
        template: run.status === 'success' ? 'green' : 'red' },
      elements: [{ tag: 'markdown',
        content: `${(run.summary || run.error || '(无输出)').slice(0, 2000)}\n<font color="grey">runner ${runnerId} · ${item.source} · ${run.scheduled_at}</font>` }],
    },
  };
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  } catch (e) { log(`[feishu] ${e.message}`); }
}

// ---------------------------------------------------------------------------
// 上报(outbox:存可重放的 /report 调用;断线累积,恢复补传)
// ---------------------------------------------------------------------------
function enqueueOp(op) {
  const seq = String(state.outbox_seq++).padStart(9, '0');
  fs.writeFileSync(path.join(OUTBOX_DIR, `${seq}.json`), JSON.stringify(op));
  saveState();
}

async function flushOutbox() {
  for (const f of fs.readdirSync(OUTBOX_DIR).sort()) {
    const p = path.join(OUTBOX_DIR, f);
    let op;
    try { op = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { fs.unlinkSync(p); continue; }
    if (!op || !op.op) { fs.unlinkSync(p); continue; } // 旧格式/损坏,丢弃
    try {
      await api(op.op, op.body);
      fs.unlinkSync(p);
    } catch (e) {
      if (e.retriable) { log(`[outbox] ${f} 稍后重试: ${e.message}`); return; } // 网络/5xx:留待下轮
      log(`[outbox] ${f} 永久失败,丢弃: ${e.message}`); fs.unlinkSync(p); // 4xx(如 job 已被接管)
    }
  }
}

function reportRun(item, run) {
  enqueueOp({ op: 'report', body: {
    jobId: item.jobId, status: run.status, exitCode: run.exit_code ?? null,
    summary: run.summary, error: run.error, startedAt: run.started_at, finishedAt: run.finished_at,
  } });
}

// ---------------------------------------------------------------------------
// 串行执行队列 + 主循环
// ---------------------------------------------------------------------------
const queue = [];
const enqueued = new Set(); // 本进程内已排队的 dedupKey,防同一 tick 重复入队
let working = false;

function enqueue(items) {
  for (const it of items) {
    if (state.done[it.dedupKey] || enqueued.has(it.dedupKey)) continue;
    enqueued.add(it.dedupKey);
    queue.push(it);
  }
}

async function processQueue() {
  if (working) return;
  working = true;
  while (queue.length) {
    const item = queue.shift();
    const key = item.dedupKey;
    if (state.done[key]) { enqueued.delete(key); continue; }

    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    log(`[run] ${item.name}(${item.source})sched=${item.scheduledAt}`);

    let result;
    if (!workdirAllowed(item.workdir)) {
      result = { status: 'rejected', error: `workdir 不在本地白名单: ${item.workdir}` };
    } else {
      result = await runClaude(item, runId);
    }

    const run = {
      scheduled_at: item.scheduledAt, started_at: startedAt, finished_at: new Date().toISOString(),
      status: result.status, exit_code: result.exitCode ?? null,
      summary: result.summary || null, error: result.error || null,
    };
    state.done[key] = { status: result.status, at: run.finished_at }; saveState();
    enqueued.delete(key);
    log(`[run] ${item.name} -> ${result.status}`);
    reportRun(item, run);
    await flushOutbox();
    await notifyFeishu(item, run);
  }
  working = false;
}

async function tick() {
  let online = true;
  // 先补传上一轮攒下的上报
  try { await flushOutbox(); } catch (e) { log(`[tick/outbox] ${e.message}`); }
  // 心跳拿版本
  let remoteVersion = null;
  try { remoteVersion = await heartbeat(); } catch (e) { online = false; log(`[heartbeat] ${e.message}`); }
  // 版本变了才拉全量定时任务定义(仅刷新本地缓存,不驱动执行)
  if (online && remoteVersion !== null && remoteVersion !== state.schedule_version) {
    try { await syncSchedules(); } catch (e) { log(`[sync] ${e.message}`); }
  }
  // 唯一执行入口:领取待办队列(webhook / 手动 / 定时都在服务器侧生成为 job)
  if (online) {
    try { enqueue(await claimJobs()); } catch (e) { log(`[claim] ${e.message}`); }
  }
  processQueue();
}

log(`[cc-runner] 启动 runner_id=${runnerId} poll=${POLL_MS / 1000}s(纯中心化,任务一律 /claim 领取)`);
tick();
setInterval(tick, POLL_MS);

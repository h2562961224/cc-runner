// 配置加载与规范化。runner.js 和 bin/cli.js 共用,保证两边对"账号"的理解一致。
//
// 配置有两种形态,都能读:
//   1) 多账号(推荐):{ max_concurrent_jobs, accounts: [{ name, api_url, runner_token, ... }] }
//   2) 单账号扁平(旧版):{ api_url, runner_token, ... }  —— 自动包成 name 为 default 的单账号
// 顶层的公共字段(poll_interval_seconds / claude_bin / model / ...)是所有账号的默认值,
// account 里写同名字段即覆盖。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME_DIR = process.env.CC_RUNNER_HOME || path.join(os.homedir(), '.cc-runner');
const CONFIG_PATH = process.env.CC_RUNNER_CONFIG || path.join(HOME_DIR, 'config.json');
const DATA_ROOT = path.join(HOME_DIR, 'data');

// 云端下发的 workdir 常含字面量 ~(平台 UI 里用户自然会填 ~/xxx),path.resolve 不认
// ~,会拼成 <cwd>/~/xxx。这里统一把开头的 ~ 展开成 home,再交给 resolve/白名单/spawn。
function expandTilde(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 账号名 -> 文件系统安全的目录名。账号名在配置里校验唯一,所以这个 key 也唯一。
function accountKey(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
}

function dataDirFor(name) {
  return path.join(DATA_ROOT, accountKey(name));
}

// 顶层可写、account 可覆盖的字段
const INHERITED = [
  'api_url', 'poll_interval_seconds', 'claude_bin', 'claude_args', 'model',
  'default_feishu_webhook', 'job_pull_limit', 'allowed_workdirs', 'env',
];

function loadRaw() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return null; }
}

function saveRaw(raw) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600); // 里面有 runner token
}

// raw config -> { maxConcurrent, accounts: [...] }
function normalize(raw) {
  const maxConcurrent = Math.max(1, Number(raw.max_concurrent_jobs) || 1);
  let accounts = [];
  if (Array.isArray(raw.accounts) && raw.accounts.length) {
    accounts = raw.accounts.map((a, i) => {
      const inherited = {};
      for (const k of INHERITED) if (raw[k] !== undefined) inherited[k] = raw[k];
      return { name: `account${i + 1}`, ...inherited, ...a };
    });
  } else if (raw.api_url || raw.runner_token) {
    const flat = { ...raw };
    delete flat.accounts;
    delete flat.max_concurrent_jobs;
    accounts = [{ name: 'default', ...flat }];
  }
  return { maxConcurrent, accounts };
}

// 返回人类可读的问题列表,空数组 = 配置可用
function validate(conf) {
  const problems = [];
  if (!conf.accounts.length) {
    problems.push('配置里没有任何账号,先跑: cc-runner init --api <runner-api地址> --token <X-Runner-Token>');
    return problems;
  }
  const seen = new Set();
  for (const a of conf.accounts) {
    const label = a.name || '(未命名)';
    if (!a.name) problems.push('有账号缺 name');
    else if (seen.has(a.name)) problems.push(`账号名重复: ${a.name}(名字决定数据目录,必须唯一)`);
    else seen.add(a.name);
    for (const k of ['api_url', 'runner_token']) {
      if (!a[k]) problems.push(`账号 ${label} 缺少 ${k}(旧版 cloud_url/service_key 已废弃)`);
    }
  }
  return problems;
}

module.exports = {
  HOME_DIR, CONFIG_PATH, DATA_ROOT, INHERITED,
  expandTilde, accountKey, dataDirFor,
  loadRaw, saveRaw, normalize, validate,
};

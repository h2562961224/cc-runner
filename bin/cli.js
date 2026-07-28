#!/usr/bin/env node
// cc-runner CLI:init(写配置)/ add|remove|list(多账号)/ start(前台跑)
//              / install(挂 launchd 常驻)/ uninstall / status
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const {
  HOME_DIR, CONFIG_PATH, INHERITED, dataDirFor, loadRaw, saveRaw, normalize, validate,
} = require('../config');

const LOG_DIR = path.join(HOME_DIR, 'logs');
const PLIST_LABEL = 'com.cc-runner.daemon';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

const [cmd, ...rest] = process.argv.slice(2);

// 简易 flag 解析:--key value,可重复的收集为数组
function parseFlags(argv, multi = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    if (multi.includes(k)) (out[k] = out[k] || []).push(v);
    else out[k] = v;
  }
  return out;
}

function usage() {
  console.log(`cc-runner — 云端下发、本地执行的 Claude Code 任务守护进程

用法:
  cc-runner init --api <runner-api地址> --token <X-Runner-Token> [选项]   写配置到 ~/.cc-runner/
      选项: --name <账号名>    账号标识,决定数据目录(默认 default)
            --workdir <path>   允许执行任务的目录白名单,可重复(默认 ~)
            --feishu <webhook> 默认飞书通知地址
            --poll <秒>        轮询间隔(默认 30)
            --model <model>    执行任务用的模型
            --force            覆盖已有的多账号配置
      说明: runner 身份由 token 决定,凭证在控制台 Runner 页复制、可随时重置

  cc-runner add --name <账号名> --api <地址> --token <token> [同上选项]
                               再挂一组 token/工作区到同一个进程(多 workspace)
  cc-runner remove --name <账号名> [--purge]   摘掉一个账号(--purge 连数据目录一起删)
  cc-runner list               列出所有账号

  cc-runner start              前台运行(调试用)
  cc-runner install            挂载为 launchd 常驻服务(macOS,开机自启+守护)
  cc-runner uninstall          卸载 launchd 服务
  cc-runner status             查看运行状态与最近任务(按账号分组)`);
}

function requireConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('还没配置,先跑 cc-runner init(命令可从云端控制台「接入指引」页复制)');
    process.exit(1);
  }
}

// 从 flag 拼一个 account 对象,只写用户实际给了的字段
function accountFromFlags(f, defaultName) {
  const a = {
    name: f.name || defaultName,
    api_url: f.api.replace(/\/$/, ''),
    runner_token: f.token,
    allowed_workdirs: f.workdir || [os.homedir()],
  };
  if (f.poll) a.poll_interval_seconds = parseInt(f.poll, 10);
  if (f.feishu) a.default_feishu_webhook = f.feishu;
  if (f.model) a.model = f.model;
  return a;
}

// 读出来永远按多账号形态回写,避免 CLI 还要处理扁平/嵌套两种写法
function loadForEdit() {
  const raw = loadRaw() || {};
  const conf = normalize(raw);
  return { raw, accounts: conf.accounts };
}

function writeAccounts(raw, accounts, maxConcurrent) {
  // 顶层的公共默认值(api_url/poll/model/...)normalize 时已经并进各 account,
  // 不再重复写回顶层;其余顶层字段是用户自己加的,原样留着。
  const out = { ...raw };
  for (const k of INHERITED) delete out[k];
  delete out.name; delete out.runner_token; delete out.runner_id; // 旧扁平配置的残留
  out.max_concurrent_jobs = maxConcurrent ?? raw.max_concurrent_jobs ?? 1;
  out.accounts = accounts;
  saveRaw(out);
}

switch (cmd) {
  case 'init': {
    const f = parseFlags(rest, ['workdir']);
    if (!f.api || !f.token) { console.error('init 需要 --api 和 --token'); process.exit(1); }
    const existing = loadRaw();
    if (existing && !f.force) {
      const n = normalize(existing).accounts.length;
      if (n > 1) {
        console.error(`已有 ${n} 个账号的配置,init 会全部覆盖。想再加一个用 cc-runner add,确实要重置加 --force`);
        process.exit(1);
      }
    }
    const acct = accountFromFlags(f, 'default');
    acct.claude_args = ['--dangerously-skip-permissions'];
    writeAccounts({}, [acct], 1);
    console.log(`已写入 ${CONFIG_PATH}(账号 ${acct.name})`);
    console.log('下一步: cc-runner install(常驻)或 cc-runner start(前台调试)');
    break;
  }

  case 'add': {
    const f = parseFlags(rest, ['workdir']);
    if (!f.api || !f.token || !f.name) { console.error('add 需要 --name、--api 和 --token'); process.exit(1); }
    const { raw, accounts } = loadForEdit();
    if (accounts.some((a) => a.name === f.name)) {
      console.error(`账号 ${f.name} 已存在(名字决定数据目录,必须唯一)。先 remove 或换个名字`);
      process.exit(1);
    }
    const acct = accountFromFlags(f);
    acct.claude_args = ['--dangerously-skip-permissions'];
    accounts.push(acct);
    writeAccounts(raw, accounts);
    console.log(`已添加账号 ${acct.name},白名单: ${acct.allowed_workdirs.join(', ')}`);
    console.log('重启守护进程生效: cc-runner install(会先卸载再挂载)');
    break;
  }

  case 'remove': {
    const f = parseFlags(rest);
    if (!f.name) { console.error('remove 需要 --name'); process.exit(1); }
    const { raw, accounts } = loadForEdit();
    const left = accounts.filter((a) => a.name !== f.name);
    if (left.length === accounts.length) { console.error(`没有叫 ${f.name} 的账号`); process.exit(1); }
    writeAccounts(raw, left);
    console.log(`已摘掉账号 ${f.name}`);
    if (f.purge) {
      fs.rmSync(dataDirFor(f.name), { recursive: true, force: true });
      console.log(`数据目录已删除: ${dataDirFor(f.name)}`);
    } else {
      console.log(`数据目录保留在 ${dataDirFor(f.name)}(要删加 --purge)`);
    }
    break;
  }

  case 'list': {
    requireConfig();
    const conf = normalize(loadRaw() || {});
    const accounts = conf.accounts;
    console.log(`并发上限: ${conf.maxConcurrent}`);
    for (const a of accounts) {
      const wd = (a.allowed_workdirs || []).join(', ') || '(空 — 所有任务都会被拒)';
      console.log(`- ${a.name}  ${a.api_url}`);
      console.log(`    token: ...${String(a.runner_token || '').slice(-6)}  poll: ${a.poll_interval_seconds || 30}s`);
      console.log(`    workdirs: ${wd}`);
    }
    const problems = validate(conf);
    for (const p of problems) console.log(`  ! ${p}`);
    break;
  }

  case 'start': {
    requireConfig();
    require(path.join(__dirname, '..', 'runner.js'));
    break;
  }

  case 'install': {
    requireConfig();
    if (process.platform !== 'darwin') {
      console.error('install 目前只做了 macOS launchd;Linux 请用 systemd 跑 `cc-runner start`');
      process.exit(1);
    }
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${path.join(__dirname, 'cli.js')}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(LOG_DIR, 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(LOG_DIR, 'daemon.log')}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}</string>
    <key>HOME</key><string>${os.homedir()}</string>
  </dict>
</dict></plist>`;
    fs.writeFileSync(PLIST_PATH, plist);
    try { execSync(`launchctl unload ${PLIST_PATH} 2>/dev/null`); } catch (_) { /* 未加载过 */ }
    execSync(`launchctl load -w ${PLIST_PATH}`);
    console.log(`已挂载 launchd 服务 ${PLIST_LABEL}(开机自启,crash 自动拉起)`);
    console.log(`日志: tail -f ${path.join(LOG_DIR, 'daemon.log')}`);
    break;
  }

  case 'uninstall': {
    try { execSync(`launchctl unload ${PLIST_PATH} 2>/dev/null`); } catch (_) { /* 忽略 */ }
    if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
    console.log('已卸载(配置和数据保留在 ~/.cc-runner,需要的话手动删)');
    break;
  }

  case 'status': {
    requireConfig();
    let loaded = false;
    try { loaded = execSync('launchctl list').toString().includes(PLIST_LABEL); } catch (_) { /* 非 macOS */ }
    console.log(`launchd: ${loaded ? '已挂载' : '未挂载'}`);
    const { accounts } = loadForEdit();
    for (const a of accounts) {
      const dir = dataDirFor(a.name);
      console.log(`\n账号 ${a.name}  (${dir})`);
      try {
        const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
        console.log(`  同步版本: ${st.schedule_version},定时任务数: ${(st.schedules || []).length}`);
        const done = Object.entries(st.done || {}).sort((x, y) => (x[1].at < y[1].at ? 1 : -1)).slice(0, 5);
        for (const [k, v] of done) console.log(`  最近执行: ${k}  ${v.status}  ${v.at}`);
      } catch (_) { console.log('  还没有本地状态(从未成功同步/执行)'); }
      const outbox = path.join(dir, 'outbox');
      if (fs.existsSync(outbox)) {
        const n = fs.readdirSync(outbox).length;
        if (n) console.log(`  待补传上报: ${n} 条`);
      }
    }
    break;
  }

  default:
    usage();
    process.exit(cmd ? 1 : 0);
}

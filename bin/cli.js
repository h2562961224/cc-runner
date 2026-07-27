#!/usr/bin/env node
// cc-runner CLI:init(写配置)/ start(前台跑)/ install(挂 launchd 常驻)
//              / uninstall / status
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const HOME_DIR = process.env.CC_RUNNER_HOME || path.join(os.homedir(), '.cc-runner');
const CONFIG_PATH = path.join(HOME_DIR, 'config.json');
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
      选项: --workdir <path>   允许执行任务的目录白名单,可重复(默认 ~)
            --feishu <webhook> 默认飞书通知地址
            --poll <秒>        轮询间隔(默认 30)
            --model <model>    执行任务用的模型
      说明: runner 身份由 token 决定,凭证在控制台 Runner 页复制、可随时重置
  cc-runner start              前台运行(调试用)
  cc-runner install            挂载为 launchd 常驻服务(macOS,开机自启+守护)
  cc-runner uninstall          卸载 launchd 服务
  cc-runner status             查看运行状态与最近任务`);
}

function requireConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('还没配置,先跑 cc-runner init(命令可从云端控制台「接入指引」页复制)');
    process.exit(1);
  }
}

switch (cmd) {
  case 'init': {
    const f = parseFlags(rest, ['workdir']);
    if (!f.api || !f.token) { console.error('init 需要 --api 和 --token'); process.exit(1); }
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const cfg = {
      api_url: f.api.replace(/\/$/, ''),
      runner_token: f.token,
      runner_id: f.runner || '', // 留空:身份以服务器 heartbeat 返回的为准
      poll_interval_seconds: f.poll ? parseInt(f.poll, 10) : 30,
      allowed_workdirs: f.workdir || [os.homedir()],
      default_feishu_webhook: f.feishu || '',
      model: f.model || '',
      claude_args: ['--dangerously-skip-permissions'],
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    fs.chmodSync(CONFIG_PATH, 0o600); // 里面有 runner token
    console.log(`已写入 ${CONFIG_PATH}`);
    console.log('下一步: cc-runner install(常驻)或 cc-runner start(前台调试)');
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
    try {
      const st = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'data', 'state.json'), 'utf8'));
      console.log(`同步版本: ${st.schedule_version},定时任务数: ${(st.schedules || []).length}`);
      const done = Object.entries(st.done || {}).sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).slice(0, 5);
      for (const [k, v] of done) console.log(`  最近执行: ${k}  ${v.status}  ${v.at}`);
    } catch (_) { console.log('还没有本地状态(从未成功同步/执行)'); }
    const outbox = path.join(HOME_DIR, 'data', 'outbox');
    if (fs.existsSync(outbox)) {
      const n = fs.readdirSync(outbox).length;
      if (n) console.log(`待补传上报: ${n} 条`);
    }
    break;
  }

  default:
    usage();
    process.exit(cmd ? 1 : 0);
}

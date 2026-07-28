# cc-runner

云端下发、本地执行的 Claude Code 任务守护进程。**做这套东西的初衷:告警 webhook 一响,本地 cc 自动排查、把"要不要紧"回给你。** 云端是唯一事实源;本地只做三件事——轮询拉取、到点执行、结果上报。零 npm 依赖,Node ≥ 18。

本地全程**只有出站 HTTPS,不监听任何端口**——所以告警回调打到云端,不需要在你的机器上开公网入口。每次请求带 `X-Runner-Token`,**令牌即身份**(服务器据此认出是哪台 runner),凭证在控制台 Runner 页复制、可随时重置。

## 纯中心化:一律先领取

runner **不做任何本地自主调度**——不算 cron、不离线自跑。**要执行的任务(webhook 触发 / 手动立即执行 / 定时到期)全部由服务器生成为待领队列,runner 先 `/claim` 领到才执行。** 断网就是纯粹拉不到任务,恢复后接着领。

```
                          云端应用(唯一调度中心)
  告警/CI/GitLab webhook ─┐
  界面手动"立即执行"      ├──▶ 服务器生成待领队列(pending job)
  定时任务到期(服务器算)─┘                 │
                                            ▼ /claim 逐条领取(服务器原子置 claimed)
  ┌──────────────────────── cc-runner 守护进程(launchd 常驻)────────────────────┐
  │            claude -p(headless)                              飞书通知          │
  └──────────────────────────────────────┬──────────────────────────────────────┘
                                          ▼ /report 回填(outbox 断线补传)
```

- **`/heartbeat`** 每 30s 打卡,返回定时任务版本号。
- **`/sync`** 版本变了拉本机定时任务定义——**仅本地缓存供 `status` 展示,不驱动执行**(执行一律走 `/claim`)。
- **`/claim`** 唯一执行入口:逐条领取服务器生成的 pending job。
- **`/report`** 回填结果(只能改自己领走的那条)。

## 安装(用户视角,一次粘贴)

```bash
npm i -g @h2562961224/cc-runner
cc-runner init --api https://<your-project>.example.com/functions/v1/runner-api --token <X-Runner-Token> --workdir ~/your-project
cc-runner install        # 挂载 launchd:开机自启、crash 自动拉起
```

验证:`cc-runner status`;日志 `tail -f ~/.cc-runner/logs/daemon.log`。

## 多账号:一个进程挂多组 token / 工作区

一台机器要同时接几个 workspace(不同组织、不同项目、公私分开)时,不用起多个进程 —— `add` 就行:

```bash
cc-runner add --name acme     --api https://a.example.com/functions/v1/runner-api --token <tokenA> --workdir ~/work/acme
cc-runner add --name personal --api https://b.example.com/functions/v1/runner-api --token <tokenB> --workdir ~/side
cc-runner list        # 看所有账号
cc-runner remove --name acme [--purge]
```

每个账号是一个**独立实例**:独立轮询、独立队列、独立数据目录 `~/.cc-runner/data/<账号名>/`。所以

- **去重表不串**:两个服务器各发一条 `id=1` 的 job,`dedup_key` 都是 `job:1`,但 `done` 表按账号分家,不会被误吞。
- **白名单按账号收窄**:`allowed_workdirs` 挂在账号上 —— 多账号场景下这是账号之间**唯一的隔离边界**,acme 的任务落不进 personal 的目录。
- **并发有闸**:账号内串行,跨账号再过一层进程级 `max_concurrent_jobs`(默认 1),免得 N 个账号同时把机器跑满。要放开就在 config 顶层调大。

配置形态(顶层字段是所有账号的默认值,账号里写同名字段即覆盖):

```jsonc
{
  "max_concurrent_jobs": 1,
  "poll_interval_seconds": 30,          // 公共默认
  "accounts": [
    { "name": "acme", "api_url": "...", "runner_token": "...", "allowed_workdirs": ["~/work/acme"] },
    { "name": "personal", "api_url": "...", "runner_token": "...", "allowed_workdirs": ["~/side"],
      "poll_interval_seconds": 60,      // 覆盖公共默认
      "env": { "FOO": "bar" } }         // 透传给 claude 子进程的环境变量
  ]
}
```

旧版单账号扁平配置(顶层直接写 `api_url`/`runner_token`)照常能读,首次启动会自动把 `data/state.json`、`data/outbox/` 并进 `data/default/`,待补传的上报和 done 表都不丢。

> ⚠️ 多 token 隔离的是**平台侧身份**(哪个 workspace 的队列、结果回填到哪),**不隔离本地 Claude 登录态** —— 所有任务都由同一个 `claude` 二进制、同一份凭证执行。要按账号分开计费/换号,用账号的 `env` 字段透传对应的环境变量。

## 协议契约(runner-api,全部 POST + `X-Runner-Token`)

| 动作 | 调用 | 返回 |
|---|---|---|
| 心跳 + 拿版本 | `POST /heartbeat` | `{ok, runner, orgId, orgName, schedulesVersion}` |
| 拉定时任务定义 | `POST /sync`(版本变了才拉,全量覆盖) | `{version, runner, orgId, schedules:[...]}` |
| 领队列任务 | `POST /claim`(逐条领到空为止) | `{job}` 或 `{job: null}` |
| 回填队列结果 | `POST /report`(只能改自己领走的那条) | `{ok, jobId, status}` |

`/report` body:`{jobId, status, exitCode, summary, error, startedAt, finishedAt}`。

- **幂等**:所有任务由服务器 `/claim` 原子认领,天然不会被两台 runner 抢到同一条;本地 `done` 表再兜一层,防同一进程内重复入队。
- **上报走 outbox**:结果先落 `~/.cc-runner/data/outbox/`,每轮先补传再领新;断线累积、恢复补传。网络/5xx 重试,4xx(如 job 已被接管)丢弃不死循环。
- **定时任务**:cron/once 到期由**服务器**生成待领 job,runner 和 webhook/手动一视同仁地领取、执行、`/report` 回填——所以定时任务结果同样进服务器 job 历史。
- **崩溃恢复**:领取后没跑完就 crash 的任务,会停在服务器侧 `claimed`——本 runner 不自动重跑(宁缺勿重),由服务器/控制台按超时回收或人工重新触发。

## 安全边界

- 本地只有出站 HTTPS,不监听端口。
- 云端建任务 ≈ 在本机执行代码:`allowed_workdirs` 白名单**由本地 config 说了算**,云端下发的 workdir 不在白名单内直接 `rejected`,不执行。白名单**按账号独立**,多账号之间靠它隔离。
- `config.json` 含 runner token,权限 0600;默认 `--dangerously-skip-permissions` 跑 cc,介意就改 `claude_args`(如 `--permission-mode acceptEdits`)。

## 目录

```
~/.cc-runner/
├── config.json              init/add 生成(0600)
├── logs/daemon.log          launchd 重定向
└── data/
    └── <账号名>/            每个账号一套,互不干扰
        ├── state.json       定时任务版本+缓存+done 表+outbox 序号
        ├── outbox/          待补传的 /report(可重放)
        └── transcripts/     每次执行的 cc 原始输出(按 run_id)
```

## 已知取舍(MVP)

- 轮询间隔即指令延迟(默认 30s);想更低做 long-poll,协议不用改。
- cron 回看窗口 48h;`catchup_latest` 停机超 48h 不补。
- 账号内串行,跨账号受 `max_concurrent_jobs`(默认 1)限流,同刻多任务排队;超时 SIGKILL。
- 日志不轮转,大了自己清。

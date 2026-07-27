# CC 任务控制台接入指南（Skill）

> 面向 **agent 自动执行**。把告警 webhook 或定时任务，自动交给你本地机器上的 Claude Code 执行 —— 告警一响，本地 cc 自动排查并回填结论。按顺序做完四步即可：① 连中心项目 → ② 装本地 runner → ③ 建触发器/定时 → ④ 查记录。涉及在本机执行代码，装 runner 前务必和用户确认 workdir（见第二步安全提示）。

## 这是什么

CC 任务控制台把两类触发，转成本地 Claude Code 的自主执行：

- **Webhook 触发（主用途）**：腾讯云告警、GitLab、CI 等打一个回调过来 → 本地 `claude -p` 自动排查 → 结论回填控制台。做这套东西的初衷就是「告警一响，本地 cc 自动告诉你要不要紧」。
- **定时触发**：cron / 一次性任务，到点由服务器生成待领任务，runner 领走执行。

架构是**中心化的**：云端一个中心项目记录任务、下发指令、汇总结果；你本地跑一个守护进程 `cc-runner`，只做出站轮询（不监听任何端口），拉指令、执行、回填。

---

## 配置（已填好，可直接复制运行）

中心项目地址与 anon key（anon key 设计上就可公开，安全）已在本文填好，所有用户通用：

- 中心项目地址：`https://bb41veoe8re43upmktc6.db.superun.com`
- Edge Function OpenAPI manifest：`https://id--1799105425833984-40e8d3eebf4e4e18893a4b0309261dc4.superun.yun/superun/openapi.json`

以下每个用户各自持有、**切勿写进公开文档或提交仓库**：

- 你的登录凭证（`superun login` 用的 token 或邮箱密码）
- runner token（`cc-runner init --token` 用，在控制台 **Runner 页**复制，可随时重置）
- 每个 webhook 触发器的 `secret`

---

## 前置条件

在开始前，确认本机具备（缺什么先装什么）：

```bash
node -v            # 需要 >= 18
claude --version   # Claude Code CLI 必须已安装并登录过（runner 会调 claude -p 执行任务）
```

- **Claude Code CLI 必须能直接跑** —— runner 靠它执行任务。先 `claude` 交互跑一次确认已登录。
- 安装两个 CLI：

```bash
npm i -g superun-cli   # 管理侧：连项目、建任务、查记录（命令为 superun）
npm i -g cc-runner     # 执行侧：本地守护进程（命令为 cc-runner，包名以最终发布为准）
```

---

## 第一步：连接中心项目（superun）

注册中心项目并以本人身份登录。**注意 superun 用的是项目根地址，不带 `/rest/v1`；`--manifest` 让 `superun fn` 认得 Edge Functions。**

```bash
superun init --name cc-task-console \
  --url https://bb41veoe8re43upmktc6.db.superun.com \
  --anon-key eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg0ODg4NDAwLCJleHAiOjIxMDAyNDg0MDB9.mhgBlmntm49GKhGxH4OEUX8v0yglI48mzjN1knyQ9Vk \
  --manifest https://id--1799105425833984-40e8d3eebf4e4e18893a4b0309261dc4.superun.yun/superun/openapi.json
```

登录（拿到 token 用 token，最省事；也支持邮箱密码）：

```bash
superun login --token <你的访问令牌>
# 或： superun login --password --email <邮箱> --pass <密码>
```

验证连上了、看得到那几张表：

```bash
superun whoami        # 能解出你的身份
superun db tables     # 应能看到 schedules / webhook_triggers / jobs / runners / sync_meta
```

> 之后所有 `superun db ...` 都以你登录的身份执行，受 RLS 约束 —— 你只能看到/操作自己有权限的数据。这也是为什么管理走 superun，而不是拿 service key 直连。

---

## 第二步：安装本地 runner（cc-runner）

runner 是真正在你机器上执行任务的守护进程。它走 **runner 专属通道**，令牌即身份 —— 在控制台 **Runner 页**「创建 runner」拿到 `X-Runner-Token`，填进 `--token`。

> ⚠️ **安全边界（务必和用户确认）**：`--workdir` 是白名单，等于**授权云端在这台机器上、以这个目录为工作区，跑 Claude Code**（默认 `--dangerously-skip-permissions`）。只把你确实想让它操作的项目目录加进来。云端下发的任务若 workdir 不在白名单，会被本地直接拒绝执行。

```bash
cc-runner init \
  --api https://bb41veoe8re43upmktc6.db.superun.com/functions/v1/runner-api \
  --token <控制台 Runner 页复制的 X-Runner-Token> \
  --workdir ~/你的项目目录

cc-runner install    # 挂常驻：macOS 走 launchd（开机自启 + crash 自动拉起）；Linux 用 systemd 跑 `cc-runner start`
cc-runner status     # 看是否已同步、launchd 是否挂载
```

这台机器的 runner 身份由 token 决定（不再手填 `--runner`）。首次心跳后，它会自动出现在控制台「看板」。想在多台机器跑，就在控制台各建一个 runner、拿各自的 token，在每台机器 `init`。

验证心跳到了云端：

```bash
superun db select runners --select id,last_seen_at,version
```

---

## 第三步：创建 webhook 触发器（主用途）

一条触发器 = 一个回调地址 + 一段排查说明书。用 `superun db insert` 建：

```bash
superun db insert webhook_triggers --data '{
  "name": "节点/Pod 健康告警",
  "slug": "k8s-health",
  "secret": "<生成一个随机串，如 openssl rand -hex 16>",
  "prompt_template": "收到一条 K8s 告警。请只读排查：定位告警对象，看 describe / logs --previous / events / top，判断是 urgent / attention / ignore，最后给出结论和依据。不要做任何写操作。",
  "workdir": "~/你的项目目录",
  "runner": "<目标 runner 名，见控制台看板，如 default>",
  "timeout_seconds": 900,
  "dedup_paths": ["alarmPolicyInfo.policyName", "alarmObjInfo.dimensions"],
  "dedup_window_seconds": 1800
}'
```

字段要点：

- **`slug`**：回调地址的路径段，唯一。
- **`secret`**：调用方必须带的令牌，自己生成一个随机串。
- **`prompt_template`**：交给 Claude 的说明书；系统会自动把原始告警 JSON 附在末尾。
- **`runner`**：在哪台机器执行，填目标 runner 名（控制台看板里那个，由令牌决定，默认 `default`）。
- **`dedup_paths` + `dedup_window_seconds`**：按 payload 里这几个字段的值 + 时间窗做去重，同一窗口内的重复告警只跑一次，天然抗告警风暴。

拿到回调地址（把 `<slug>` `<secret>` 换成上面的值），填进腾讯云可观测→告警策略的接口回调、或 GitLab/CI 的 webhook：

```
https://bb41veoe8re43upmktc6.db.superun.com/functions/v1/hook/<slug>?token=<secret>
```

原有的飞书/邮件通知照留，这个回调是**额外加一条**。

自测一下整条链路（发一条假 payload，看是否入队 → 被 runner 认领 → 跑出结论）：

```bash
curl -X POST "https://bb41veoe8re43upmktc6.db.superun.com/functions/v1/hook/<slug>?token=<secret>" \
  -H "Content-Type: application/json" \
  -d '{"alarmPolicyInfo":{"policyName":"点火测试"},"note":"self test, not a real alert"}'
# 返回 {"queued":true,"jobId":"..."} 即入队成功；约 30~60s 后在「查看记录」里能看到结果
```

---

## 第四步（可选）：创建定时任务

定时任务走 `schedules` 表。cron（5 段：分 时 日 月 周）或一次性 `once`：

```bash
# 每个工作日 18:00 跑一次回归检查
superun db insert schedules --data '{
  "name": "每日回归检查",
  "type": "cron",
  "cron": "0 18 * * 1-5",
  "prompt": "跑一遍冒烟测试，把失败项和可疑点总结给我。",
  "workdir": "~/你的项目目录",
  "runner": "<目标 runner 名，如 default>",
  "timeout_seconds": 600
}'

# 一次性：某个时间点之后跑一次（type=once + not_before）
superun db insert schedules --data '{
  "name": "上线后 2 小时看效果",
  "type": "once",
  "not_before": "2026-08-01T12:00:00Z",
  "prompt": "检查新功能上线后的日志和指标，判断有没有异常。",
  "workdir": "~/你的项目目录",
  "runner": "<目标 runner 名，如 default>"
}'
```

定时任务由**服务器统一调度**：到期时服务器生成一条待领 job，runner `/claim` 领走执行、回填结果（和 webhook / 手动任务同一条路径）。runner 不在本地算 cron。`once` 跑成功后自动停用。

---

## 查看执行记录

所有执行结果（webhook / 定时 / 手动）都落在 `jobs` 表 —— 定时任务到期由服务器生成 job，runner 领取执行后同样回填，历史完整。

```bash
# 最近 20 条
superun db select jobs \
  --select "source,status,summary,started_at,finished_at" \
  --order "created_at.desc" --limit 20

# 只看失败的
superun db select jobs --eq status=failed --order "created_at.desc" --limit 20

# 只看某个 runner
superun db select jobs --eq runner=<目标 runner 名，如 default> --order "created_at.desc" --limit 20
```

`status` 含义：`pending` 待认领 / `claimed` 执行中 / `success` 成功 / `failed` 失败 / `timeout` 超时 / `rejected`（workdir 不在本地白名单，被拒）。`summary` 是 Claude 给出的结论，`error` 是失败原因。

本地侧也能快速看：

```bash
cc-runner status                        # 同步版本、最近执行、待补传条数
tail -f ~/.cc-runner/logs/daemon.log    # 守护进程实时日志
```

---

## 运维与排查

- **runner 显示离线**（看板灰点 / `last_seen_at` 很旧）：`cc-runner status` 看 launchd 是否挂载；`tail ~/.cc-runner/logs/daemon.log` 看报错。断网期间领不到新任务（纯中心化，不本地自跑）；已跑完待回填的结果攒在 outbox，恢复后自动补传。
- **任务 `rejected`**：workdir 不在本地白名单。要么改触发器/定时的 `workdir`，要么 `cc-runner init` 时把目录加进 `--workdir`（可重复传多个）。
- **webhook 打过去没反应**：确认地址带对了 `?token=<secret>`；`secret` 不匹配返回 401，`slug` 不存在返回 404。
- **卸载**：`cc-runner uninstall`（配置和数据保留在 `~/.cc-runner`，需要再手删）。

---

## 安全边界（一句话版）

- 本地只有**出站 HTTPS**，不监听任何端口 —— 告警回调打到云端，不需要在你机器上开公网入口。
- workdir 白名单**由本地说了算**，云端下发不在白名单的目录一律拒绝执行。
- 管理操作走 `superun` 登录身份（RLS 约束），不发 service key 给用户；runner 的访问 key 存在本地 `~/.cc-runner/config.json`（权限 0600），别提交进仓库。

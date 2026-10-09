# DSH Weixin Web

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供微信 iLink 通道。插件运行在 DSH 的 `web` profile 中，将微信消息注入独立会话，并在 DSH 原生界面中提供微信入口与状态面板。

![DSH 原生微信入口](docs/assets/dsh-native-weixin.png)

## 功能

- 在 DSH 左侧栏提供“微信”入口，以原生覆盖层打开管理面板。
- 页面点击生成二维码并完成登录；没有终端登录命令。
- 长轮询接收微信消息，每位联系人对应一个独立 DSH 会话。
- 会话按最近微信消息的分钟分组，展示联系人、最后消息和未读状态。
- 时间线保留微信原文、处理状态和发回微信的最终回复。
- 支持主动推送、广播、长文本分片、语音转文字和图片附件保存。
- 凭据、会话映射和更新游标保存于 `$DSH_HOME/dsh-weixin-web`。

## 安装

需要 Node.js 20.3 或更新版本，以及已可运行的 DSH Web profile。

```bash
dsh plugin --profile web add github:agi-redtea/dsh-weixin-web
```

从 GitHub 安装时，包管理器会通过 `prepare` 脚本现场编译出 `dist/`。pnpm ≥ 10 默认拦截依赖的构建脚本：第一次 `add` 会失败（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），按报错提示把 `dsh-weixin-web` 加入该 profile 的 `pnpm-workspace.yaml`（`onlyBuiltDependencies` / `allowBuilds`）后重新执行即可。

安装后重启 DSH：

```bash
dsh web --port 3080
```

进入 DSH，点击左侧栏的 **微信** 即可使用原生微信抽屉。二维码登录、联系人和消息时间线均在此处呈现，不再提供独立的 `/weixin` 管理页面。

## 配置

在 web profile 的 `cordis.patch.yml` 中按需覆盖：

```yaml
- insert:
    - id: weixin
      name: dsh-weixin-web
      config:
        replyMode: full
        maxChunk: 1500
```

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `stateDir` | `$DSH_HOME/dsh-weixin-web` | 凭据、会话映射和消息游标目录 |
| `cwd` | `stateDir/workspace` | 微信会话默认工作目录 |
| `replyMode` | `full` | `full` 回发整轮文本，`last` 只回最后一条 |
| `replyTimeoutMs` | `900000` | 单轮回复超时（毫秒）；超时会取消该会话当前轮次 |
| `approvalPolicy` | `never` | 微信会话的审批策略。`never`：需要审批的操作直接拒绝（微信端无法批准，`ask` 会让整轮挂起） |
| `maxChunk` | `1500` | 单条微信消息最大字符数 |
| `sendIntervalMs` | `2000` | 两条发送之间的最小间隔（毫秒） |

## 多机器人

- 每个机器人是一条独立的 iLink 长轮询（一个 `bot_token`），互不影响；会话标题里的机器人名用于区分。
- 状态存放：`bots.json`（机器人列表与凭据，权限 0600）、`session-map.v2.json`（按机器人分开的会话映射）、`bufs/<机器人id>.json`（各机器人的收消息游标）。
- 从旧版（0.1.x 的 `credentials.json`）升级时自动迁移，旧文件原样保留不删除；旧机器人的游标与会话映射会继续同步写回旧文件，回滚旧版时直接可用。
- 机器人管理（改名、暂停/恢复、解绑）见抽屉，对应插件路由 `POST /dsh-weixin-web/bot/rename|pause|resume|delete`（与 `status`、`login/start`、`login/verify`、`logout` 一样经 DSH 浏览器会话鉴权）；暂停期间的消息在恢复后由 iLink 补发并照常处理；解绑只删除本机凭据与游标，会话保留，再次绑定同一微信号会接回原会话。

## 会话与工作区

- 入站消息的来源为 `{ kind: 'user', channel: 'dsh-weixin-web', peer, bot? }`，因此正文按用户消息原样渲染，同时保留渠道与对端信息。
- 插件启动后会确保存在「微信」工作区（路径为 `config.cwd`，默认 `<stateDir>/workspace`），并把它排到工作区列表首位；已有会话在启动时自动挂入并补上标题，不会新建会话。
- 标题由 `sessionTitle` 固定（来源标记为用户），首条回复生成前即写入，避免被自动标题覆盖。

## 开发

```bash
pnpm install
pnpm test
pnpm pack
```

`pnpm test` 会构建 TypeScript 并运行通道、凭据、iLink、会话分钟分组、抽屉 RPC 以及浏览器端 `client.js`（jsdom + React）测试。

## 安全

微信登录、联系人和消息数据通过 DSH 的受认证原生通道呈现；插件不再暴露独立的公网管理路由。

## License

MIT

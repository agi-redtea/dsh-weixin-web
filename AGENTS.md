# 给后续编码代理

本仓库是 DSH 微信插件。运行时行为以 `src/*.mts` 和手写的 `client.js` 为准。不要为了通过检查去改测试，也不要改插件的对外行为，除非任务明确要求。

## 提交前

```bash
pnpm check && pnpm test
```

两项都通过后再开 pull request。CI 会在 Node.js 20 和 22 上执行 `pnpm install --frozen-lockfile`、`pnpm check` 和 `pnpm test`，不使用任何仓库密钥。

## 不要提交状态和令牌

机器人令牌、会话和游标只放在 DSH 状态目录（默认 `$DSH_HOME/dsh-weixin-web`）。不要提交下列文件；`.gitignore` 已忽略它们：

- `bots.json`
- `credentials.json`
- `session-map*.json`
- `bufs/`
- `activity*.json`
- `updates-buf.json`

也不要提交 `.env` 或任何真实 `bot_token`。测试里只能使用明显的假数据。

## `client.js` 与 `src` 保持同步

`client.js` 是 DSH 浏览器端实际加载的模块，不是 `tsc` 的产物。`pnpm build` 只把 `src/*.mts` 编译到 `dist/`。

改了 RPC、登录流程、面板状态或展示文案时，同一改动里同时更新 `client.js` 和对应的 `src` 模块。只改一边会让网页和通道不一致，而 `pnpm check` 发现不了。

不要恢复已删除的 `src/client.mts`。`tsconfig.build.json` 仍排除该路径，避免它被打进发布包。

# 贡献说明

人类贡献者和编码代理遵循同一套规则，完整说明见 [AGENTS.md](./AGENTS.md)。

提交 pull request 之前在本地运行：

```bash
pnpm check && pnpm test
```

不要提交运行时状态目录或机器人令牌（`bots.json`、`credentials.json`、`session-map*.json`、`bufs/`、`activity*.json`、`updates-buf.json`，以及 `.env`）。

`client.js` 是手写的浏览器模块，不由 TypeScript 编译生成。改通道协议或管理面板时，必须与 `src` 一起改。

# 2048 挑战平台 / 2048 Challenge Platform

面向学校的中英文 2048 挑战平台。教师可以管理房间、学生、团队和正式比赛成绩；学生可以练习、管理自己的团队并参加 1v1 或 3v3 比赛。正式版本由一个 Cloudflare Worker 同源承载 React SPA、REST API 和 WebSocket。

## 技术栈

- React、TypeScript、Vite、i18next
- Hono Worker、D1、Durable Objects、WebSocket Hibernation API
- 共享确定性 2048 引擎
- Vitest、Cloudflare Workers Vitest、Playwright

产品边界与验收规则见 [需求文档](docs/requirements-v1.md)，数据、接口和实时协议见 [技术设计](docs/architecture-v1.md)。旧 `standalone-demo.html` 仅保留为 Git 历史原型，不进入 Vite/Worker 正式构建。

## 本地开发

需要 Node.js 22+。首次运行：

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run cf-typegen
npm run db:migrate:local
```

把 `.dev.vars` 中的占位值替换为本地测试值。该文件已被 Git 忽略。随后分别启动 Worker 和 Vite：

```bash
npm run dev:worker
npm run dev
```

访问 `http://localhost:5173`。Vite 会把 `/api` 和 WebSocket 转发到 `http://127.0.0.1:8787`。

## 验证

```bash
npm run check
npm run test:e2e
```

`npm run check` 包含 Cloudflare 类型生成、格式、Lint、翻译键一致性、类型检查、共享引擎测试、Worker/D1/Durable Object 集成测试和生产构建。Playwright 覆盖 360×800、390×844、两种 iPad 方向以及中英文桌面尺寸。

部署后的完整 3v3、WebSocket、触屏/键盘和结算烟雾测试可通过 `npm run smoke:online` 运行；所需 URL 与密码由 `SMOKE_BASE_URL`、`ONLINE_TEACHER_PASSWORD`、`ONLINE_STUDENT_PASSWORD` 环境变量传入，脚本不会输出凭据。

## Cloudflare 部署

1. 创建名为 `challenge-platform` 的 D1 数据库，并把 ID 写入 `wrangler.jsonc`。
2. 在 GitHub Actions Secrets 配置：
   - `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
   - `BOOTSTRAP_TEACHER_USERNAME`、`BOOTSTRAP_TEACHER_PASSWORD`、`BOOTSTRAP_TEACHER_NAME`
   - `INITIAL_STUDENT_PASSWORD`
   - `PASSWORD_PEPPER`、`PRACTICE_SIGNING_KEY`、`IMPORT_SIGNING_KEY`
3. PR 执行完整 CI。`main` 的 CI 成功后，部署工作流应用 D1 迁移、发布 Worker/静态资源并同步运行时 Secrets。

生产入口默认为 `2048-challenge-platform.<account-subdomain>.workers.dev`。密码与签名密钥不得提交到仓库；首次部署成功后，教师登录会以配置的唯一管理员账号初始化数据库。

密码使用 PBKDF2-SHA-256、每用户独立随机盐和服务端 Pepper；迭代数设置为 Cloudflare Workers WebCrypto 当前支持的上限 100,000。

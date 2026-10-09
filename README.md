# 2048 挑战平台 / 2048 Challenge Platform

面向学校的中英文 2048 挑战平台。教师可以管理房间、学生、团队和正式比赛成绩；学生可以练习、管理自己的团队并参加 1v1 或 3v3 比赛。正式版本由一个 Cloudflare Worker 同源承载 React SPA、REST API 和 WebSocket。

## 技术栈

- React、TypeScript、Vite、i18next
- Hono Worker、D1、Durable Objects、WebSocket Hibernation API
- 共享确定性 2048 引擎
- Vitest、Cloudflare Workers Vitest、Playwright

产品边界与验收规则见 [需求文档](docs/requirements-v1.md)，数据、接口和实时协议见 [技术设计](docs/architecture-v1.md)。旧 `standalone-demo.html` 仅保留为 Git 历史原型，不进入 Vite/Worker 正式构建。

当前榜单规则：个人榜单在教师设置的榜单周期内分为“自由练习”和“限时赛”两种模式，各自提供总榜和年级榜。自由练习按每人已验证且正常结束的最好一局排名，依次比较分数、最高方块、有效步数；限时赛按每人得分最高的最多 10 局已结算的 3 分钟成绩平均分排名，少于 10 局按实际局数计算。两种成绩分别统计，不互相混合。团队榜单按独立的 3v3 练习期统计已结算对战积分（胜 3、平 1、负 0），关闭后在已开赛房间结算完毕时冻结。旧的个人练习分加总团队榜接口返回 `410`，团队积分通过团队练习期接口查询。上述规则取代需求文档和技术设计中早期的单一练习榜和队员练习分加总榜单描述。

完整的界面、计时与全屏棋盘设计说明见 [UI 设计文档](docs/ui-design.md)，其中包含历史原型的图片预览。

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

部署后的完整 3v3、WebSocket、触屏/键盘和结算烟雾测试可通过 `npm run smoke:online` 运行；所需 URL 与密码由 `SMOKE_BASE_URL`、`ONLINE_TEACHER_PASSWORD`、`ONLINE_STUDENT_PASSWORD` 环境变量传入，脚本不会输出凭据。远程链路较慢时，可用 `SMOKE_MATCH_MINUTES=3` 延长测试房间，默认为 1 分钟。

## Cloudflare 部署

### 测试环境

`wrangler.jsonc` 的 `staging` 环境使用独立 Worker `2048-challenge-platform-staging`、独立 D1 `challenge-platform-staging` 和独立 Durable Object 命名空间；入口为 `https://2048-challenge-platform-staging.jihe-gao.workers.dev`。该环境绑定预览域名 `https://preview.2048.gaojihe.cn`，使用独立测试数据和测试账号。先在安全位置准备测试环境专用的 7 个运行时密钥，JSON 键名与下方 GitHub Actions Secrets 列表中的业务密钥相同，然后运行：

```bash
npx wrangler d1 migrations apply DB --env staging --remote
npm run check
npx wrangler deploy --env staging --secrets-file /absolute/path/to/staging-secrets.json
```

用测试环境自己的教师账号、学生初始密码运行 `npm run smoke:online`。确认测试环境的真实登录、比赛和成绩流程，并确认 PR 的 CI 通过后，再合并到 `main`；合并会触发下方的正式环境部署工作流。不要把正式密钥用于测试环境。

### 正式环境

1. 创建名为 `challenge-platform` 的 D1 数据库，并把 ID 写入 `wrangler.jsonc`。
2. 在 GitHub Actions Secrets 配置：
   - `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
   - `BOOTSTRAP_TEACHER_USERNAME`、`BOOTSTRAP_TEACHER_PASSWORD`、`BOOTSTRAP_TEACHER_NAME`
   - `INITIAL_STUDENT_PASSWORD`
   - `PASSWORD_PEPPER`、`PRACTICE_SIGNING_KEY`、`IMPORT_SIGNING_KEY`
3. PR 执行完整 CI。`main` 的 CI 成功后，部署工作流应用 D1 迁移、发布 Worker/静态资源并同步运行时 Secrets。

正式入口为 `https://mingcheng2048.cn`（由 `wrangler.jsonc` 的 Custom Domain 绑定到正式 Worker），Worker 地址仍可用于部署诊断。密码与签名密钥不得提交到仓库；首次部署成功后，教师登录会以配置的唯一管理员账号初始化数据库。

密码使用 PBKDF2-SHA-256、每用户独立随机盐和服务端 Pepper；迭代数设置为 Cloudflare Workers WebCrypto 当前支持的上限 100,000。

## 正式页面、团队图标与直播

当前源码将 preview 的蓝色像素视觉界面用于正式构建；正式 Worker 保留生产 D1、Durable Object 与密钥绑定。测试环境仍独立使用 `preview.2048.gaojihe.cn`，不会将测试数据复制到生产。

创建团队时可选择附件中的 9 个 SVG 图标，团队详情、列表与比赛直播页使用同一图标。旧团队的 emoji 图标仍可显示，无需数据库迁移。

教师直播页支持全屏和浏览器限制原生全屏时的展开模式。侧栏比分、所选团队图标和黄色柱顶平台同步移动。统一柱高尺度为 `sqrt(clamp(score, 0, 16384) / 16384)`；零分使用最低平台位置，16384 分及以上达到设计稿 Y=400 的上限，最低位置对应 Y=1000。布局按可用空间等比适配。队名侧栏超过 6 字时显示前 5 字与省略号，完整名称保留在提示和中央对战标题中。

Silkscreen 字体随站点打包，来源为 [Google Fonts](https://github.com/google/fonts/tree/main/ofl/silkscreen)，许可见 `public/fonts/OFL.txt`，不依赖在线字体服务。

## 离线淘汰赛

管理员在“团队管理”点击“导出离线淘汰赛”，下载包含当前所有未解散团队名称及图标的 ZIP；不导出学生、密码或比赛资料。完整解压到指定目录，直接打开 `8-teams.html` 或 `4-teams.html`，无需网络或本地服务器。

- 8 队版：8 → 4 → 2 → 冠军；4 队版：4 → 2 → 冠军。
- `teams/teams.js` 保存团队名称与图标映射，`teams/logos/` 保存实际 SVG 文件；新导出包的整个 `teams` 目录可替换旧目录。
- 填写团队名称即自动显示对应图标，点击胜者的箭头确认晋级。修改队伍或胜者后自动清除该路径后续结果。
- 自动保存、JSON 进度备份与恢复、中英文、全屏展示及打印均可离线使用。两版进度独立。
- 详见离线包的 `README.txt`。仓库静态入口位于 `public/offline/index.html`，未导入团队资料时显示操作提示。

Custom Domain 的上线前提是 `mingcheng2048.cn` 已在同一 Cloudflare 账号中作为活动 Zone，且没有冲突的 CNAME；参见 [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。合并到 `main` 并通过 CI 后，现有部署工作流发布页面与域名配置。

# TODO：正式域名、预览上线与比赛直播体验

状态：待实现。本文用于跟踪需求，所有复选框仅在完成实现与验收后勾选。

## 1. 正式域名使用 mingcheng2048.cn

- [ ] 正式站点使用 `https://mingcheng2048.cn`。
- [ ] 更新正式域名绑定、部署配置和相关入口文档。
- [ ] 验收：通过该域名可以正常登录、访问页面、调用 API 并连接比赛 WebSocket。

## 2. preview 页面切换到正式环境

- [ ] 将当前 preview 展示的页面版本发布到正式环境，成为正式页面。
- [ ] 页面使用正式环境的登录、API 和 WebSocket。
- [ ] 验收：通过正式域名看到 preview 的页面版本，使用正式账号完成登录、比赛及成绩查看。
- [ ] 上线前核对正式环境的数据和密钥绑定，避免将测试数据、测试账号或测试密钥带入正式环境。

## 3. preview Logo 从 1024 改为 2048

- [ ] 将 preview 页面中显示的品牌 Logo 从 1024 改为 2048，并随页面版本上线。
- [ ] 使用随本 PR 保存的用户附件 [通用-Logo.svg](assets/mingcheng2048-logo.svg) 作为品牌视觉参考。
- [ ] 验收：登录页、导航等展示该品牌 Logo 的位置统一显示 2048，中文、英文与移动端均正确。

![用户提供的 2048 Logo](assets/mingcheng2048-logo.svg)

附件为原始 SVG，内容原样保存；此品牌 Logo 与各团队自身的 Logo 分别使用。

## 4. 比赛直播页面支持全屏切换

- [ ] 比赛直播页面提供进入全屏和退出全屏的操作。
- [ ] 退出全屏（包括浏览器退出和 Esc）时，按钮状态与实际状态一致。
- [ ] 全屏下比分、计时、团队信息和棋盘布局适配可用空间。
- [ ] 验收：正常模式与全屏模式可以反复切换，实时比分、计时和 WebSocket 更新持续正常；不支持全屏的浏览器有明确反馈。

## 5. 比赛直播页展示真实团队 Logo 与柱顶小人

- [ ] 两侧展示对应团队实际设置的 Logo，与团队管理页一致；没有 Logo 时显示明确的默认标识。
- [ ] 团队小人站在各自记分柱的柱顶。
- [ ] 比分推动记分柱升高时，小人随柱顶同步升高。
- [ ] 验收：双方使用不同团队 Logo 时显示正确；从零分到较高分的连续更新中，小人的脚始终与柱顶贴合，普通模式和全屏模式均无裁切或遮挡。

“小人高度随柱升高变化”在此按小人的纵向位置随柱顶变化理解；小人自身尺寸不作为本条需求的验收依据。

## 6. 创建团队时的图标库更新为附件 team_logos.zip

- [ ] 将创建团队时的可选图标库替换为附件中的 9 个 SVG 图标（icon1.svg 至 icon9.svg），保留原始图案和配色。
- [ ] 图标选择器直接展示这些 SVG，支持明确的选中状态；提交创建后保存所选图标。
- [ ] 团队创建后，团队详情、团队列表和比赛直播页均显示同一个所选图标。
- [ ] 兼容已有团队的旧图标记录，保证升级后能正常显示。
- [ ] 验收：9 个图标逐一可选，创建并刷新后选择仍正确；团队列表和直播页与创建时的选择一致，桌面、移动端与 iPad 无图标变形或裁切。

素材原样保存在 [docs/assets/team-logos](assets/team-logos/)；压缩包中的 macOS 元数据不作为图标素材。

| 图标 | 预览 |
| --- | --- |
| icon1.svg | ![icon1.svg](assets/team-logos/icon1.svg) |
| icon2.svg | ![icon2.svg](assets/team-logos/icon2.svg) |
| icon3.svg | ![icon3.svg](assets/team-logos/icon3.svg) |
| icon4.svg | ![icon4.svg](assets/team-logos/icon4.svg) |
| icon5.svg | ![icon5.svg](assets/team-logos/icon5.svg) |
| icon6.svg | ![icon6.svg](assets/team-logos/icon6.svg) |
| icon7.svg | ![icon7.svg](assets/team-logos/icon7.svg) |
| icon8.svg | ![icon8.svg](assets/team-logos/icon8.svg) |
| icon9.svg | ![icon9.svg](assets/team-logos/icon9.svg) |

## 后续验收记录

- [ ] 上述六项实现完成。
- [ ] 中英文桌面、移动端与 iPad 页面验证通过。
- [ ] 比赛直播实时更新、全屏切换及比赛结束状态验证通过。



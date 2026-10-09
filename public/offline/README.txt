2048 离线淘汰赛 / Offline knockout tournament

1. 管理员登录线上平台，进入“团队管理”，点击“导出离线淘汰赛”。
2. 将下载的 ZIP 完整解压到指定目录。不要直接在压缩包中打开 HTML。
3. 双击 8-teams.html（总共 8 队）或 4-teams.html（总共 4 队）。不需要网络或本地服务器。
4. 在首轮席位填写团队名称，名称必须与导出资料一致，可从输入提示中选择。
5. 两个对手均匹配后，点击胜者右侧箭头晋级。继续选择半决赛/决赛胜者，直到冠军。
6. 更改首轮队伍或改选胜者，会清除该路径后续晋级结果，请重新确认。
7. 浏览器会尝试自动保存。建议使用“保存进度”下载 JSON 备份；“载入进度”恢复同队伍数量的版本。
8. 更新团队资料时，重新导出并解压。teams/teams.js 包含名称与 Logo 对应关系；teams/logos/ 包含 SVG。
   将新的 teams 目录整体替换到页面旁边，重新打开页面。仅复制 HTML 无法获得团队图标。
9. 两版的进度各自独立。名称重复、未找到团队、重复席位或缺失图标时，页面会提示。
10. 使用“全屏展示”或“打印”进行现场展示；语言按钮可以切换中英文。

Download the ZIP from Team management → Export offline tournament, and extract all files.
Open 8-teams.html or 4-teams.html directly. Keep teams/ and fonts/ beside the HTML files.
Enter an exported team name to match its logo, then click the winning team's arrow to advance.
Changing a participant or an earlier winner clears its downstream results.
Save progress downloads a JSON backup; Load progress restores the corresponding 4/8-team version.
To refresh the directory, replace the entire teams/ folder with a fresh export and reopen the page.

Fonts: Silkscreen, bundled under the SIL Open Font License (see fonts/OFL.txt).

# 共享 QQ 账号歌单

歌单面板会自动显示**服务器共享 QQ 账号**的“我喜欢的音乐”和自建歌单。这不是每个网页访客独立的 QQ 登录；共享账号可读取的私密自建歌单也会展示给能够访问本网页的用户。

## 使用

1. 在“QQ 音乐登录凭据”中扫码登录，或保存有效 Cookie。
2. 打开播放列表，查看“共享 QQ 账号歌单”。“我喜欢的音乐”置顶；刷新按钮只刷新目录。
3. 点击歌单查看详情。“加入队列”仅追加；“播放全部”播放首个成功加入的歌曲，其他歌曲追加，不清空已有队列。
4. “另存为本地歌单”保留歌曲 ID 快照。重复保存不覆盖原本的本地修改；缺失 ID 的歌曲不可导入，不按歌名替换版本。

自动同步不播放歌曲、不入队、不预下载音频，也不触发节拍分析。收藏按钮仍写入原来的本地默认歌单。上游返回不完整时，需勾选确认后才能处理已获取的部分。

## 缓存与账号变化

- 页面初始化、扫码成功、保存 Cookie 后自动同步目录。打开面板时目录超过五分钟才刷新，没有持续轮询。
- 服务器将目录短时缓存 60 秒，同账号请求合并；手动刷新保留 5 秒防重复窗口。读取使用独立凭据快照，不改变播放器客户端。
- 浏览器目录存储键为 `minerats-qq-library-v1`，只含不透明账号标识、歌单元数据和时间。服务器未确认账号时不展示旧缓存；只有相同凭据版本可恢复标明失败的旧目录。
- 歌单详情只缓存于当前页面内存，最多 10 份、五分钟有效，按需读取。导入和另存前重新核对当前账号及目录归属。
- 本页清除凭据后立即移除共享目录；其他访客切换账号后，在下次同步中识别。旧响应不会覆盖新账号。已经开始的导入使用固定歌曲快照，可通过原有“停止导入”结束。
- 本地歌单仍使用 `minerats-playlists-v2`，不做破坏性迁移。退出共享账号不会删除另存的本地副本。

## 只读接口

| 接口 | 参数 | 返回 |
| --- | --- | --- |
| `GET /qqmusic/library` | 可选 `refresh=true` | `status`、不透明 `account_id`／`account_version`、`items`、`complete` |
| `GET /qqmusic/library/playlists/{id}` | 必填 `account_version` | `status`、账号标识、`playlist` 元数据和兼容现有详情适配器的 `data` |

网页通过 `/api` 前缀访问。沿用部署已有的 API 鉴权策略；兼容模式不增加 Token 要求。

业务状态为 `ready`、`unconfigured`、`expired`、`unavailable`、`account_changed`、`not_found`。QQ 登录失效不使用 HTTP 401，避免被误判为缺少网页 API Token；非法歌单 ID 或版本格式返回 HTTP 400。

目录适配 QQ 的 `tid`、`diss_name`、`diss_cover`、`song_cnt`，按 `dirid=201` 识别“我喜欢”，排除空间背景音乐等系统目录。详情只允许读取当前账号目录中的 ID。响应和日志不输出 Cookie；旧 `/qqmusic/login/status` 也不再返回原始 Cookie。

## 验证

在项目根目录执行，测试使用临时数据或本地夹具，不改变真实队列：

```powershell
npm --prefix web test
npm --prefix web run build
backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -v
backend/.venv/Scripts/python.exe -m scripts.ci_browser_smoke --report artifacts/ci-browser/report.json
```

专用单元测试覆盖目录分页、系统条目、请求合并、账号切换、部分详情及清空期间的准备任务取消；专用浏览器夹具覆盖桌面、移动和减少动态效果模式。所有测试入队请求均在本地拦截，不能将夹具运行到公网地址。

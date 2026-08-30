# MineraTS Web 前端

当前前端是 Vite 5 构建的原生 JavaScript 单页应用，使用 Three.js 和
GSAP，不使用 Vue、TypeScript、Tailwind 或前端路由框架。

## 开发命令

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

从仓库根目录执行时可使用 `npm --prefix web <command>`。

## 目录结构

```text
web/
├── index.html
├── public/vendor/          # 固定版本的浏览器依赖
├── src/
│   ├── main.js             # 组装模块和渲染循环
│   ├── style.css
│   ├── core/               # API、WebSocket、节拍与本地壁纸
│   ├── shared/             # 状态、事件、歌单和通用 UI
│   ├── visual/             # Three.js 粒子、相机、歌词和 3D 卡片
│   └── player/             # DOM 播放器、搜索、队列和设置面板
├── tests/                  # Node 测试
└── vite.config.js          # 开发/预览代理和构建配置
```

## 模块边界

- `StateManager` 保存共享播放状态并发出状态事件。
- `EventBus` 负责模块间消息。
- `visual/` 与 `player/` 不直接互相导入；跨层交互必须经过共享状态或
  EventBus。
- `ApiClient` 负责 HTTP，`WsClient` 负责播放状态推送和重连。
- `main.js` 只负责装配、生命周期和每帧更新，避免继续堆积业务逻辑。

修改事件名、共享状态字段或接口路径前，应先搜索全部生产代码和测试
消费者。粒子材质、歌词着色器和卡片 Mesh 会在高频渲染路径中运行，
不要在每帧代码里创建纹理、材质、几何体或大型临时数组。

## 网络契约

浏览器默认使用同源路径：

- `/api/*`：普通后端接口，代理时移除 `/api`。
- `/admin/*`：管理员接口，保留路径。
- `/ws/status`：播放状态 WebSocket。
- `/cover/*`：外部封面代理。

开发与 preview 代理目标由 `TSBOT_WEB_API_PROXY_TARGET` 控制；未设置时
根据 `TSBOT_HOST` 和 `TSBOT_PORT` 推导。`VITE_API_BASE` 推荐保持
`/api`。

若后端启用 API Token，构建时设置相同的 `VITE_API_TOKEN`。前端构建
变量会进入静态产物，不能把它当作高强度的服务端秘密；生产环境仍应
配合网络边界和管理员接口独立鉴权。

## 动态壁纸

动态壁纸由用户在视觉设置中选择本地视频：

- `LocalWallpaperStore` 负责浏览器端持久化与对象 URL 生命周期。
- 视频不上传后端，服务器也不再提供默认动态壁纸。
- 页面加载时恢复当前站点下已保存的视频。
- 用户可关闭、重新启用或移除壁纸。
- 清理站点数据、更换域名或端口会改变浏览器存储范围。

处理视频对象 URL 时必须及时释放旧 URL，但不能在视频仍被使用时提前
释放。相关行为由 `tests/local-wallpaper.test.mjs` 覆盖。

## 视觉稳定性

当前节拍和相机效果包含平滑与限幅逻辑，用于避免生硬抖动。调整
`BeatScheduler`、`CameraDirector` 或 `ParticleStage` 时：

1. 保持时间步长无关的插值，避免效果随帧率变化。
2. 对瞬时脉冲设置上限和衰减，不直接把原始节拍值写入相机。
3. 在暂停、切歌、标签页恢复和 WebSocket 重连时检查状态复位。
4. 执行 `motion-smoothing.test.mjs` 和完整前端测试。

## 测试与交付

```bash
npm test
npm run build
```

当前测试覆盖节拍调度、动作平滑、QQ 登录契约、WebSocket 鉴权和本地
壁纸、封面代理。构建成功后应再检查：

- 首屏无 JavaScript 错误。
- 搜索、入队、播放控制和歌词正常。
- WebSocket 能连接并在断线后恢复。
- 本地壁纸的选择、刷新恢复、关闭和移除正常。
- 构建产物不存在对服务器默认视频文件的请求。

新增行为优先写可在 Node 中运行的契约测试；依赖 WebGL 或真实浏览器的
视觉变化，应在项目根目录同时运行：

```bash
bash ./verify-deployment.sh --with-browser
```

生产浏览器验收默认不修改服务器状态；有状态模式的限制和失败产物见
根目录 `HOWTOSTART.md`。

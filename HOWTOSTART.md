# TSBot 部署和运行指南

本文只说明安装、启动、升级和排障。项目功能见 [README](README.md)，
接口字段见 [API 文档](docs/API.md)。

## 1. 部署前准备

推荐使用 Docker Compose。若需本地开发，建议使用与 Dockerfile 一致的
Python 3.11、Node.js 20.19+ 和 Rust 1.88，并安装 CMake、C/C++ 工具链及
FFmpeg。

复制环境模板：

```bash
cp tsbot.env.example tsbot.env
```

`tsbot.env` 含敏感配置，不应提交到版本库。至少修改：

- `TSBOT_COOKIE_KEY`
- `TSBOT_API_TOKEN` 或 `TSBOT_API_TOKENS`
- `TSBOT_ADMIN_TOKEN`（当前原生 Web 控制台的管理员操作使用）
- `TSBOT_TS3_HOST`
- `TSBOT_TS3_PORT`
- `TSBOT_TS3_NICKNAME`
- `TSBOT_TS3_CHANNEL_ID` 或 `TSBOT_TS3_CHANNEL_PATH`

需要网易云功能时，另行部署 `NeteaseCloudMusicApi` 并设置
`TSBOT_NETEASE_API_BASE`。QQ 音乐和 B 站无需额外 API 服务，登录态可在
Web 控制台中配置。

## 2. Docker Compose（推荐）

### 从源码构建

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100
```

访问 `http://127.0.0.1:8080`。停止服务：

```bash
docker compose down
```

普通停止不要附加 `-v`，以免误删数据卷。默认挂载：

- `./data` → 后端数据库。
- `./logs` → 日志、PID 和 TeamSpeak identity。

### 使用预构建镜像

先在 `tsbot.env` 中设置镜像仓库、命名空间、仓库名前缀和固定标签，
然后运行：

```bash
docker compose -f docker-compose.prebuilt.yml pull
docker compose -f docker-compose.prebuilt.yml up -d
```

生产环境应使用明确的版本标签，不要依赖会漂移的 `latest`。升级前备份
`tsbot.env`、`data/` 和 `logs/identity.json`，升级后检查三个容器状态及
Web、OpenAPI、WebSocket。

`docker-compose.portable.yml` 仅用于已经导入对应本地镜像标签的离线
部署，不会尝试拉取镜像。

## 3. Linux 本地运行

### 安装与构建

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
npm --prefix web ci
cargo build --manifest-path voice-service/Cargo.toml --locked
```

也可使用：

```bash
make backend-setup
make web-build
make voice-build
```

### 前台启动

在三个终端分别运行：

```bash
./run-voicemake.sh
./run-backend.sh
./run-web.sh
```

脚本会读取项目根目录的 `tsbot.env`。`run-web.sh` 会先构建，再以 Vite
preview 方式监听 `TSBOT_WEB_PORT`。

### 后台启动

```bash
chmod +x nohup-start.sh nohup-stop.sh nohup-status.sh
./nohup-start.sh
./nohup-status.sh
./nohup-stop.sh
```

后台脚本按端口判断服务状态，并将输出写入 `logs/`。它适合轻量部署；
正式生产也可以用 systemd 或容器编排管理进程。

## 4. Windows 本地运行

PowerShell 脚本会通过 `scripts/Import-TsbotEnv.ps1` 读取 `tsbot.env`。

```powershell
py -3.11 -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
npm.cmd --prefix web install
```

分别在三个 PowerShell 窗口启动：

```powershell
./run-voicemake.ps1
./run-backend.ps1
./run-web.ps1
```

Windows 语音服务还需要 Rust GNU target、MinGW-w64、CMake 与 FFmpeg。
脚本支持用 `TSBOT_CARGO`、`TSBOT_CMAKE`、`TSBOT_MINGW_BIN` 和
`TSBOT_FFMPEG` 指定工具位置。

## 5. 开发模式

后端热重载：

```bash
backend/.venv/bin/python -m uvicorn backend.main:app \
  --reload --host 127.0.0.1 --port 8009
```

前端开发服务器：

```bash
npm --prefix web run dev
```

Vite 默认监听 `127.0.0.1:5173`，并将浏览器请求转发到后端。修改接口、
代理或鉴权后执行：

```bash
python -m unittest discover -s backend/tests -v
python -m unittest discover -s tests -v
npm --prefix web test
npm --prefix web run build
```

## 6. 端口与代理

| 服务 | 默认端口 | 建议暴露范围 |
| --- | ---: | --- |
| Web | 8080 | 对外或经 HTTPS 反代 |
| Backend | 8009 | 本机或可信内网 |
| Voice gRPC | 50051 | 容器网络或本机 |
| Vite dev | 5173 | 开发机 |

当前 Web 的代理契约为：

- `/api/*`：转发到后端，并去掉 `/api` 前缀。
- `/admin/*`：保留原路径转发到后端。
- `/ws/*`：WebSocket 转发到后端。
- `/cover/*`：封面代理路径。

Docker Web 镜像已经在 `docker/nginx-web.conf` 中实现上述规则。自行配置
Nginx、Caddy 或面板反代时必须完整保留四组路径，尤其要启用 WebSocket
Upgrade。浏览器端不应直接暴露 gRPC 服务。

## 7. 生产检查清单

- 使用长随机 `TSBOT_COOKIE_KEY`，并妥善备份；更换它会使已加密 Cookie
  无法解密。
- 保持 `TSBOT_REQUIRE_API_AUTH=true`，并配置长随机
  `TSBOT_API_TOKEN(S)`；仅在隔离的本地开发环境显式关闭。
- 为当前原生 Web 控制台配置长随机 `TSBOT_ADMIN_TOKEN`；后端同时支持
  管理员会话认证。
- 不把 `tsbot.env`、Cookie、Token、数据库或 identity 提交到仓库。
- 只公开 HTTPS Web 入口，限制 8009 和 50051。
- 固定镜像版本；部署前保留可回滚镜像和数据快照。
- 检查 `docker compose ps`、服务日志、`/docs`、WebSocket 和实际播放。
- 用户动态壁纸只从浏览器本地选择；服务器无需提供视频文件。

## 8. Web 安全发布与回滚

`deploy-web.sh` / `deploy-web.ps1` 只管理 Compose 中的 `web` 服务。工具会
从正在运行的 Web 容器读取 Compose 项目、配置文件、网络和当前镜像，
不要求手工填写服务器目录。

默认是只读 dry-run：仅检查 SSH、无密码 `sudo`、Docker、磁盘空间和
当前部署状态，不上传文件，也不执行 Compose 更新。

```bash
# Linux：只读预演
./deploy-web.sh deploy --host music.example.com

# 确认计划无误后才显式执行
./deploy-web.sh deploy \
  --host music.example.com \
  --release 20260730-web-r1 \
  --execute
```

Windows PowerShell 使用相同参数：

```powershell
./deploy-web.ps1 deploy --host music.example.com
./deploy-web.ps1 deploy --host music.example.com `
  --release 20260730-web-r1 --execute
```

正式执行时依次进行：

1. 运行前端测试、构建和部署契约测试。
2. 只打包 Web 运行文件，计算并在服务器复核 SHA256。
3. 保存切换前的容器快照、Compose 展开配置和旧 override。
4. 构建唯一标签镜像，先用绑定到 `127.0.0.1` 的临时容器验收。
5. 仅执行 `docker compose up -d --no-deps web`，并确认后端与语音容器
   ID 没有变化。
6. 对公开地址运行协议和 Chromium 浏览器验收。

探针、切换或验收失败时会恢复开始操作时的 Web override。成功报告写入
`artifacts/releases/<版本>/`，服务器版本目录保留发布清单和回滚信息。

回滚也默认只读；目标必须是服务器 `releases/` 中已经存在的版本：

```bash
./deploy-web.sh rollback \
  --host music.example.com \
  --release 20260730-192000-local-wallpaper-r1

# 核对目标镜像和 override 后执行
./deploy-web.sh rollback \
  --host music.example.com \
  --release 20260730-192000-local-wallpaper-r1 \
  --execute
```

可在 `tsbot.env` 设置 `TSBOT_DEPLOY_HOST`、`TSBOT_DEPLOY_USER`、
`TSBOT_DEPLOY_PORT`、`TSBOT_DEPLOY_PUBLIC_URL` 和
`TSBOT_DEPLOY_WEB_CONTAINER`。API Token 仍通过环境变量传给验收工具，
不要放进命令行。`--skip-local-checks` 和 `--skip-browser` 只供明确的
故障排查使用，不应作为正式发布默认值。

### 隔离故障演练

`drill-web-deployment.sh` / `drill-web-deployment.ps1` 会在远程 Docker
主机的 `/tmp/minerats-deploy-drill-*` 下创建唯一 Compose 项目，不发布
端口，也不读取生产 Compose 配置。演练结束或中途失败时都会定向清理
该项目的容器、网络、镜像和目录。

为避免演练时意外访问镜像仓库，必须显式指定服务器已经存在、
兼容 Nginx Alpine 的基础镜像；演练器只执行 `docker image inspect`，
不会主动拉取它：

```bash
# 先检查计划，不创建资源
./drill-web-deployment.sh \
  --host music.example.com \
  --base-image minerats-web:dependency-base-20260730-182500-hkt

# 在隔离项目执行故障注入
./drill-web-deployment.sh \
  --host music.example.com \
  --base-image minerats-web:dependency-base-20260730-182500-hkt \
  --execute
```

演练验证三条恢复路径：

- 临时探针失败时，活动 Web 容器完全不变。
- Web 已切换但最终验收失败时，恢复切换前的 override。
- 回滚目标无法提供 HTTP 服务时，恢复开始回滚时的 override。

每个场景同时断言 backend 和 voice-service 容器 ID 不变。结果写入
`artifacts/deployment-drills/<演练ID>/result.json`。可用
`TSBOT_DRILL_BASE_IMAGE` 保存基础镜像名。该工具会真实创建临时 Docker
资源，应只在有足够空间、允许执行故障演练的主机上使用。

## 9. 一键部署验收

验收工具只发送 GET 请求和 WebSocket `ping`，不会控制播放、修改队列或
写入配置。Linux：

```bash
export TSBOT_VERIFY_BASE_URL="https://music.example.com"
bash ./verify-deployment.sh
```

Windows PowerShell：

```powershell
$env:TSBOT_VERIFY_BASE_URL = 'https://music.example.com'
./verify-deployment.ps1
```

包装脚本会自动读取 `tsbot.env`，因此启用 `TSBOT_API_TOKEN` 时通常无需
再次传入。也可显式使用环境变量或 `--api-token`；生产环境优先使用环境
变量，避免令牌进入 shell 历史。

检查项目包括：

- Web 入口及同源 JavaScript/CSS，防止静态资源错误回落到 SPA HTML。
- `/api/openapi.json` 和关键接口是否属于当前后端版本。
- `/api/external/status` 与 `/admin/status` 代理。
- `/cover` 是否绕过 SPA fallback。
- `/ws/status` 握手、鉴权子协议和 `ping`/`pong`。

全部通过时退出码为 0，有失败时为 1，参数错误为 2。CI 可使用 JSON：

```bash
bash ./verify-deployment.sh --json
```

### 真实浏览器验收

先为当前 Python 环境安装 Chromium：

```bash
backend/.venv/bin/python -m playwright install chromium
```

然后把只读 Playwright 验收接入同一次检查：

```bash
bash ./verify-deployment.sh --with-browser
```

浏览器层会检查 WebGL 页面初始化、安全面板交互、WebSocket 帧、控制台
错误、关键网络错误、QQ 封面同源代理，以及临时浏览器上下文中的本地
壁纸“保存—刷新恢复—移除”。失败时自动输出到
`artifacts/browser-smoke/<时间>/`：

- `failure.png`
- `browser.log`
- `network.log`
- `result.json`

如需在隔离测试栈验证搜索和入队，可直接运行：

```bash
backend/.venv/bin/python scripts/browser_smoke.py \
  --mode stateful \
  --allow-state-changes \
  --search-query "测试歌曲"
```

该模式会添加一项队列后立即删除，并拒绝在远程地址上意外运行。播放
验证只允许回环地址，且必须额外确认
`--isolated-playback-confirmation THIS_IS_AN_ISOLATED_PLAYBACK_TARGET`。
不要把连接真实 TeamSpeak 频道的本机实例当作隔离测试栈。

仅在使用自签名证书的内部测试环境中使用 `--insecure`。临时排除外部
封面服务或 WebSocket 时可用 `--skip-cover`、`--skip-websocket`，但这
不应作为正式发布验收结果。

## 10. 常见问题

### Web 能打开但请求失败

确认后端 8009 正常监听，并检查 `/api`、`/admin`、`/ws` 和 `/cover`
代理规则。Web 首次使用时在“访问设置”中保存与后端一致的 API Token；
令牌只保存在当前浏览器本地，不写入前端构建产物。

### WebSocket 反复重连

检查反向代理是否传递 Upgrade/Connection 头、令牌是否正确，以及
浏览器开发者工具中的实际连接地址。

### 机器人能启动但没有声音

依次检查 voice-service 日志、TeamSpeak 地址和频道、FFmpeg、gRPC 地址
`TSBOT_VOICE_GRPC_ADDR`，以及机器人是否有进入频道和发声权限。

### 网易云不可用

从后端所在网络访问 `TSBOT_NETEASE_API_BASE`，不要用只在宿主机有效但
容器内不可达的回环地址。

### QQ 音乐或 B 站登录失效

在 Web 控制台重新扫码或更新 Cookie。不要把 Cookie 写入文档或日志。

### 动态壁纸消失

壁纸保存在当前浏览器站点的本地存储中。清理站点数据、无痕模式、
更换域名/端口或浏览器可能使其不可用，需要重新选择本地视频。

更多日志定位方法见 [LOGGING.md](LOGGING.md)。

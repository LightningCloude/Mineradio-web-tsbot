# Mineradio Web TSBot

Mineradio Web TSBot 是一个面向 TeamSpeak 的音乐播放与沉浸式视觉项目。
它将 Rust TeamSpeak 语音客户端、FastAPI 控制后端和原生 JavaScript/Three.js
Web 控制台组合在一起，重点提供可持续运行的播放器、歌词和音频响应视觉体验。

[English](README.en.md) · [部署与运行](HOWTOSTART.md) ·
[API 参考](docs/API.md) · [前端开发说明](web/README.md) ·
[日志说明](LOGGING.md)

## 项目特色
<img width="2559" height="1413" alt="image" src="https://github.com/user-attachments/assets/a1ea9a4a-acd8-4f73-9d79-5c43ca5481ac" /><img width="2559" height="1416" alt="image" src="https://github.com/user-attachments/assets/ce4add5c-f6bb-445c-82a3-6ec3dd7851af" />
<img width="2559" height="1416" alt="image" src="https://github.com/user-attachments/assets/815a7978-323c-48da-8b93-3fe6ce8bc050" /><img width="2559" height="1417" alt="image" src="https://github.com/user-attachments/assets/4a17d9ae-a231-4d53-8d0e-828bcffc3bf3" /><img width="564" height="1247" alt="image" src="https://github.com/user-attachments/assets/f7485ec8-e233-4131-a1b9-fcbe81e5eafd" /><img width="708" height="182" alt="image" src="https://github.com/user-attachments/assets/73a00084-6249-4000-8d90-f2fba3722fa0" />






- TeamSpeak6 语音播放：队列、播放/暂停、切歌、音量、随机和循环播放。
- Mineradio 风格 Web 控制台：黑色玻璃界面、3D 书架、搜索、播放列表和沉浸模式。
- 三套视觉预设：粒子墙、星河和音域回响；音域回响根据实时或分析后的音频帧驱动地形、节拍和涟漪。
- 歌词体验：原文、译文、原文+译文三种显示方式，支持逐句高亮和与歌词结束同步的扫光效果。
- 音频分析缓存：按歌曲名称共享缓存，支持当前歌曲分析、下一首预分析和书架分析状态提示。
- 本地动态壁纸：用户在浏览器中选择视频，文件保存在浏览器本地，不由服务器提供或上传。
- 音乐来源适配：内置 QQ 音乐与 B 站搜索、解析和入队能力；网易云适配保留为可选兼容模块，不是本项目运行必需项。
- 安全默认值：API 鉴权默认开启，后端和语音 gRPC 默认只绑定回环地址，生产部署适合放在 HTTPS 反向代理之后。

## 运行架构

```text
浏览器（Vite + 原生 JavaScript + Three.js）
        │ HTTP / WebSocket
        ▼
FastAPI 后端 ── gRPC ──► Rust voice-service ──► TeamSpeak
        │
        ├── 音频分析与共享缓存
        ├── QQ 音乐 / B 站适配器
        └── SQLite、管理员会话与运行时配置
```

目录职责：

- `web/`：播放器界面、歌词、书架、视觉设置、本地壁纸和 Three.js 场景。
- `backend/`：HTTP/WebSocket API、队列、音频分析缓存、鉴权和数据库。
- `voice-service/`：Rust TeamSpeak 客户端、音频处理和 gRPC 服务。
- `proto/`：后端与语音服务之间的协议定义。
- `docker-compose*.yml`、`Dockerfile.*`：源码、预构建和离线容器部署。
- `tests/` 与 `web/tests/`：后端回归、发布安全和前端契约测试。

## 快速启动

推荐使用 Docker Compose：

```bash
cp tsbot.env.example tsbot.env
# 至少填写 TeamSpeak 地址、频道、Cookie 密钥、API Token 和管理员 Token
docker compose up -d --build
docker compose ps
```

打开 `http://127.0.0.1:8080`。停止服务：

```bash
docker compose down
```

运行数据默认保存在：

- `data/`：SQLite 数据库和共享运行数据。
- `logs/`：日志、TeamSpeak identity 和初始管理员密码文件。

完整安装、Windows 启动、预构建镜像、反向代理、升级和回滚说明见
[HOWTOSTART.md](HOWTOSTART.md)。

### 使用 Docker Hub 或 GHCR 的预构建镜像

如果不想在本机编译，可以直接拉取 Actions 发布的三个镜像。先复制并编辑环境文件：

```bash
cp tsbot.env.example tsbot.env
# 填写 TSBOT_COOKIE_KEY、TSBOT_API_TOKEN、TSBOT_ADMIN_TOKEN 和 TeamSpeak 配置
```

使用本项目 Docker Hub 公共镜像（命名空间为 `lightningcloude`）：

```bash
export TSBOT_IMAGE_REGISTRY="docker.io"
export TSBOT_IMAGE_NAMESPACE="lightningcloude"
export TSBOT_IMAGE_REPO="mineradio-web-tsbot"
export TSBOT_IMAGE_TAG="latest"
# 公共镜像无需 docker login；生产环境可改用固定标签，例如 sha-758d2a5
docker compose --env-file tsbot.env -f docker-compose.prebuilt.yml pull
docker compose --env-file tsbot.env -f docker-compose.prebuilt.yml up -d
```

Docker Hub 上的三个镜像分别为：
`lightningcloude/mineradio-web-tsbot-backend`、
`lightningcloude/mineradio-web-tsbot-web`、
`lightningcloude/mineradio-web-tsbot-voice-service`。

使用 GHCR：

```bash
export TSBOT_IMAGE_REGISTRY="ghcr.io"
export TSBOT_IMAGE_NAMESPACE="lightningcloude"
export TSBOT_IMAGE_REPO="mineradio-web-tsbot"
export TSBOT_IMAGE_TAG="latest"
# 公共镜像无需登录；私有镜像使用拥有 read:packages 权限的令牌登录
# echo "$GHCR_TOKEN" | docker login ghcr.io -u LightningCloude --password-stdin
docker compose --env-file tsbot.env -f docker-compose.prebuilt.yml pull
docker compose --env-file tsbot.env -f docker-compose.prebuilt.yml up -d
```

三个镜像名称分别是 `*-backend`、`*-web` 和 `*-voice-service`。`latest` 会随
`main` 更新，生产部署更适合使用 Actions 生成的 `sha-<commit>` 固定标签。

## 最小安全配置

`tsbot.env.example` 只是模板，不要直接提交实际配置。生产环境至少设置：

```bash
export TSBOT_COOKIE_KEY="一段至少 32 个字符的长随机字符串"
export TSBOT_API_TOKEN="普通接口访问令牌"
export TSBOT_ADMIN_TOKEN="管理员操作令牌"
export TSBOT_TS3_HOST="你的 TeamSpeak 服务器地址"
export TSBOT_TS3_PORT="9987"
export TSBOT_TS3_NICKNAME="mineradio-tsbot"
export TSBOT_TS3_CHANNEL_ID="2"
```

可使用 `openssl rand -hex 32` 生成随机密钥。普通接口支持
`Authorization: Bearer <token>` 或 `x-api-token`；服务端未配置令牌时，
鉴权中间件会失败关闭，而不会开放接口。

## 默认端口

| 服务 | 端口 | 默认暴露范围 |
| --- | ---: | --- |
| Web 控制台 | 8080 | 主机入口 |
| FastAPI 后端 | 8009 | `127.0.0.1` |
| voice-service gRPC | 50051 | `127.0.0.1` |
| Vite 开发服务器 | 5173 | 本机开发 |

生产环境只公开经过 HTTPS、访问控制和限流保护的 Web 入口，不要直接公开
8009 或 50051。

## 本地开发

环境要求：Python 3.11、Node.js 20.19+、Rust 1.88，以及本地编译语音服务所需的
CMake、C/C++ 工具链和 FFmpeg。

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
npm --prefix web ci
cargo build --manifest-path voice-service/Cargo.toml --locked
```

分别启动后端、前端和语音服务的脚本见 `run-backend.*`、`run-web.*` 和
`run-voicemake.*`。前端模块边界、代理路径和视觉修改约束见
[web/README.md](web/README.md)。

## 测试与构建

```bash
# Python 后端与发布安全回归
python -m unittest discover -s backend/tests -v
python -m unittest discover -s tests -v

# 前端契约测试与生产构建
npm --prefix web test
npm --prefix web run build

# Rust 语音服务
cargo test --manifest-path voice-service/Cargo.toml --locked
```

仓库 CI 会在干净环境中运行上述检查、npm audit、Cargo 锁文件校验和 Docker
发布包检查。部署后还可以使用 `verify-deployment.*` 做只读接口与浏览器验收。

## 参考项目索引

本项目在保留原有 TeamSpeak 播放链路的基础上，吸收了以下公开项目的实现思路
或代码片段。它们不是本项目的运行时依赖：

| 项目 | 用途 | 许可 |
| --- | --- | --- |
| [NeteaseTSBot](https://github.com/yichen11818/NeteaseTSBot) | 原始后端、队列和 TeamSpeak 语音服务基础 | MIT（见 `LICENSES/NeteaseTSBot-original-MIT.txt`） |
| [Mineradio](https://github.com/XxHuberrr/Mineradio) | Web 视觉、歌词、节拍分析和书架交互参考 | GPL-3.0 |
| [Sonic Topography](https://github.com/yin-yizhen/sonic-topography) | 音域回响地形和频段响应参考 | 原项目非商业学习许可 |

具体代码范围、版权声明和完整许可文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

项目主体采用 [GNU GPL-3.0](LICENSE)。完整的第三方声明和随发布包分发的许可文本
见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [LICENSES/](LICENSES)。

其中 Sonic Topography 衍生视觉部分继续保留其原始的非商业使用限制，不因项目主体
采用 GPL-3.0 而被重新授权。使用、再分发或修改该部分时请同时遵守对应条款。

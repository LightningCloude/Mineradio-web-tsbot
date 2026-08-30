# TSBot 日志指南

TSBot 的日志分为应用日志、进程输出和浏览器控制台三类。不要把浏览器
控制台日志误认为服务器端 `web.log`。

## 日志来源

| 组件 | 本地脚本默认位置 | Docker 查看方式 |
| --- | --- | --- |
| Backend | `logs/backend.log` 或 `TSBOT_LOG_FILE` | `docker compose logs backend` |
| Voice service | `logs/voice.log` | `docker compose logs voice-service` |
| Web 服务进程 | `logs/web.log` | `docker compose logs web` |
| 浏览器前端 | 浏览器开发者工具 Console | 不写入服务器文件 |

`nohup-start.sh` 会把三个进程的标准输出分别追加到上述文件。容器模式
下优先使用 Compose 日志；挂载的 `logs/` 仍用于应用运行文件和
identity。

后端日志由 `backend/logger.py` 配置。当前实现读取日志级别，但文件路径
固定为 `logs/backend.log`：

```bash
export TSBOT_LOG_LEVEL="INFO"
```

`backend/config.py` 虽声明了 `TSBOT_LOG_FILE` 对应字段，当前 logger 尚未
使用它；在代码接通该配置前，不要依赖它改变输出位置。

## 常用命令

本地后台运行：

```bash
tail -f logs/backend.log
tail -f logs/voice.log
tail -f logs/web.log
```

仓库提供的查看脚本：

```bash
./scripts/log-viewer.sh
./scripts/log-viewer.sh -c backend
./scripts/log-viewer.sh -c voice
./scripts/log-viewer.sh -c web
```

Docker：

```bash
docker compose logs --tail=100
docker compose logs -f backend
docker compose logs -f voice-service
docker compose logs -f web
```

服务与端口状态：

```bash
./nohup-status.sh
docker compose ps
```

## 排障顺序

1. 确认对应端口正在监听，容器或进程未反复重启。
2. 查看故障组件最近 100 行，而不是先追踪全部日志。
3. 对照同一时间点检查相邻组件：Web → Backend → Voice。
4. 浏览器问题同时检查 Network、Console 和 WebSocket Frames。
5. 登录或播放失败时再检查上游音乐服务的可达性与 Cookie 状态。

## 安全与运维

- 不在日志中记录 Cookie、Token、二维码确认数据或完整加密密钥。
- 分享日志前移除服务器地址、用户标识、请求头和上游响应中的敏感字段。
- 对长期运行环境配置日志轮转；不要只依赖无限增长的 `nohup` 文件。
- `logs/identity.json` 是 TeamSpeak 身份文件，不是普通日志，应单独备份
  并限制权限。
- 前端动态壁纸仅保存在浏览器本地，不应出现在服务器日志或备份中。

若日志文件不存在，先确认服务确实通过 `nohup-start.sh` 启动，或
`TSBOT_LOG_FILE` 指向的目录可写。Docker 模式没有本地日志文件并不代表
服务没有输出，应使用 `docker compose logs`。

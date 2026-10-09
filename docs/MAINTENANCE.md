# 维护与恢复

备份包含数据库、Cookie 加密密钥、管理员配置和 TeamSpeak identity，必须保存在私有目录，
不可提交 Git 或公开分发。恢复工具不会覆盖正在运行的项目。

## 建立与验证恢复点

以下命令从项目根目录执行，使用安装了后端依赖的 Python：

```bash
python scripts/workspace_recovery.py backup --workspace . --output-dir ../backups --label before-update --keep 3
```

工具包含源码、未跟踪私有文件和 Git 元数据，对 SQLite 使用事务快照，而非直接复制活动数据库。
依赖目录、构建产物、缓存和 artifacts 不入包。每个文件与完整 ZIP 均有 SHA256 校验。
仅清理同目录中工具识别且验证成功的旧完整备份；未知或损坏文件不会自动删除。
`--keep 0` 可临时禁止清理，`--image` 可重复传入当前 Docker 镜像标识记入恢复清单。

将 backup 输出中的 archive 值设为环境变量 `BACKUP_ARCHIVE`，然后执行：

```bash
python scripts/workspace_recovery.py verify "$BACKUP_ARCHIVE"
python scripts/workspace_recovery.py restore "$BACKUP_ARCHIVE" --destination ../restore-check
```

PowerShell 使用 `$env:BACKUP_ARCHIVE` 传入归档路径。`../restore-check` 必须不存在。
先在新目录验证数据库和配置，再停止服务进行人工切换。不同部署目录上的 Docker 挂载数据
必须单独指定为 workspace 备份；仅备份本地源码不能恢复远端运行数据。

## 通信故障排查

HTTP 请求默认有 20 秒总时限，覆盖响应体读取，取消旧查询不弹出连接错误。
播放、切歌和入队不会自动重试，防止重复操作。若操作超时，先确认当前状态再手动重试。

每个 WebSocket 客户端有独立的 32 条上限队列，待发送位置消息只保留最新值。
开始、结束及 pong 不合并；单次发送超过 5 秒或可靠消息积压溢出时仅断开该慢客户端。
语音 gRPC 状态/Ping 为 3 秒截止，控制调用为 10 秒；订阅每小时重新建立，退出时取消任务。

歌词、搜索、封面与队列的异步读取受请求版本约束，切换歌曲后旧结果不能覆盖新结果。
前端连接条分别报告 HTTP 与 WebSocket 状态，不再把 WebSocket 在线当作 HTTP 必然可用。

## 音频未响应

视觉设置显示输入电平和实际来源。实时来源需要 HTTPS、Chrome/Edge 支持及用户主动共享系统音频。
选择屏幕时勾选“共享系统音频”，确认 TeamSpeak 正在向被共享的输出设备播放。
输入持续无声会提示检查扬声器；浏览器只提供授权的捕获流，不能偷偷检测其他输出设备。

没有捕获音频时，可使用本浏览器已有节拍缓存；未命中则为低潮模拟而非真实频谱。
旧歌曲下载分析/队列预分析已停用，不向服务器新增音频代理请求，也不上传或共享节拍缓存。

## 健康检查与更新

新构建/预构建镜像提供以下健康检查：

| 服务 | 检查 | 含义 |
| --- | --- | --- |
| voice-service | `voice-service --healthcheck 127.0.0.1:50051` | 有截止时间的真实 gRPC Ping，不启动第二个 TeamSpeak 客户端 |
| backend | `/health/ready` | 数据库可查询且语音 gRPC 可响应 |
| web | `/` 与 `/api/health/ready` | 静态页面和代理依赖均可访问 |

`/health/live` 只检查进程存活。就绪不代表已加入 TeamSpeak 频道或歌曲必然可解析。
旧 portable 固定镜像不支持新命令，使用 TCP/openapi 兼容检查，不能视作完整 gRPC/数据库验收。
Compose 提供 unless-stopped 重启策略与日志轮转。healthy 状态用于可观测性与启动依赖，
不是自动重启失效进程的监控器；restart 策略只在进程退出时生效。

更新时先保存运行配置、数据库、identity 和旧镜像标识，验证候选镜像，再切换。
`deploy-web.*` 仅更新前端，不会自动部署后端或语音代码；完整更新必须分别验证三个服务。
保持运行配置不变，回滚时使用上一组镜像和 Compose override，避免迁移或覆盖生产数据。

## 鉴权兼容模式

默认发布配置继续启用鉴权。可信私有部署若要使用免 API Token/管理员鉴权兼容模式，需明确配置：

```bash
TSBOT_REQUIRE_API_AUTH=false
TSBOT_API_TOKEN=
TSBOT_API_TOKENS=
TSBOT_REQUIRE_ADMIN_AUTH=false
```

已有 Cookie 密钥、数据库和 TeamSpeak 配置保持不变；不要用示例 env 覆盖真实文件。
关闭鉴权会开放管理员配置，只能放在可信网络或额外的反向代理访问控制之后。
浏览器中曾保存的令牌可清除，当前前端读取 localStorage，不读取 VITE_API_TOKEN。

## 验证与资源控制

```bash
python -m unittest discover -s backend/tests -v
python -m unittest discover -s tests -v
npm --prefix web test
npm --prefix web run build
python -m playwright install chromium
python scripts/ci_browser_smoke.py
cargo test --manifest-path voice-service/Cargo.toml --locked
```

Python 测试使用独立临时数据库、日志、密码和配置路径，不应触碰真实运行文件。
浏览器 CI 使用模拟 API/WS，不播放歌曲或修改生产队列。
高画质是默认模式，保持现有密度/亮度；自动档只调分辨率，省电档限制 30 FPS。
后台停止绘制并在恢复时清理时间窗口，避免返回标签页时跳变；WebGL 丢失/恢复不重建业务状态。

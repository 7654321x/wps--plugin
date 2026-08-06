# 第一阶段架构

## WPS Control Plane（v1.4.0，C1–C7）

```text
WPS Stable Shell → Dedicated Pipeline Worker → Local Control Server
       │                         │                    ├─ RecognitionPort
       └─ bounded WpsHostBridge ─┘                    └─ FormattingPlannerPort
```

- WPS UI 只执行短时 Host RPC，不启动服务器，也不等待 HTTP。
- Dedicated Worker 是唯一的控制面 HTTP 调用方；`packages/control-client` 统一处理 endpoint manifest、Bearer token、超时、轮询和取消。
- Control Server 只绑定 `127.0.0.1` 随机端口，使用 endpoint manifest 的 instance/PID/创建时间/版本/合同/心跳联合身份校验；它不持有 WPS 对象、不返回代码、不执行 WPS API。
- 识别执行仍由受校验的本地 runtime/Broker 边界负责，格式规则仍由既有纯命令生成核心负责。C1–C4、C6、C7 不删除旧 Broker，也不自动切换正式预览或排版；C5 Runtime RecognitionPort 接入仍待 shadow 对照。

真实 WPS diagnostic 20/200/1000、preview、format、取消、文档切换与保存后 OOXML 验收仍是后续 C14–C16 门槛。

识别在客户端本地完成，DOCX 和正文均不上传。现有 docxtool.sdk.recognize_docx 是唯一识别入口；WPS 客户端适配器只把它的文本脱敏识别计划映射为版本化 RecognitionResult。

命令服务的纯核心接收脱敏 CommandRequest 并生成声明式 FormattingCommandSet。本地和云端均使用同一个核心和同一个 HTTP API；差异仅限认证、监听、配置和模板来源。WPS API 仍只允许在客户端执行。本阶段由 MockDocumentExecutor 代替真实 WPS API。

当前不使用 Cloudflare、网页前端或管理后台。WPS 加载项有官方模板入口和受限的宿主适配器：默认只读探测；只有专用脱敏文档完成实机写入、读回与恢复后，才可发布对应写入 capability。`docs/TRANSACTION_AND_ROLLBACK.md` 规定内存补偿边界；不承诺 WPS Ctrl+Z 事务。

第三阶段增加本地开发 E2E 会话：任务窗格仅把脱敏状态和稳定错误码回传给 loopback local-agent；local-agent 将会话结果存入被忽略的 `.runtime/e2e/`。`TestDocumentGuard` 通过 session id、会话工作副本相对位置和 SHA-256 验证写入目标，拒绝 fixture 基准、未保存 DOCX 和任何用户文档。生产构建不复制开发任务窗格或故障注入脚本。

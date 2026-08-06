# 安全边界

DOCX、正文、本地路径和文件名不得进入 CommandRequest。涉密版端点仅允许 127.0.0.1 或 ::1；联网版仅允许构建时固定的 HTTPS 端点，不接受用户输入地址。

命令服务不读取 DOCX、不导入 recognition wheel、不调用 WPS API。客户端禁止 eval、new Function、shell 执行和任意代码下发。
# Security boundaries

自动诊断不会降低涉密版边界：endpoint 固定为 loopback，CORS origin 固定为任务窗格开发地址，token 不进入页面或诊断报告。`TestDocumentGuard` 仍要求 session 工作副本及 SHA-256 匹配。自动诊断不写入 WPS 文档；写入和故障恢复只能由操作员在高级验证中逐项确认。

## WPS Control Server

Control Server 只监听 `127.0.0.1` 随机高位端口，不使用固定 9528，不监听 `0.0.0.0`，没有 CORS 放行。每个请求必须使用 manifest 中的 Bearer token；token 不进入 URL、日志、诊断报告或 WPS 页面。重用实例时必须同时核对 PID、进程创建时间、instance、server/contract version、heartbeat 与鉴权响应。

服务器只编排严格 JSON。它拒绝调用方传入的 EXE、命令行、脚本、模块和代码字段，不导入 WPS API，也不持有 `Application`、`Document` 或 `Range`。WPS API 的唯一所有者仍是本地 HostBridge/Executor。

# 冻结合同

第一阶段冻结的 JSON Schema 版本均为 1.0：

- RecognitionResult
- CommandRequest
- FormattingCommandSet
- ClientCapabilities
- ExecutionResult

Schema 位于 schemas/，并禁止未知顶层字段、正文、完整路径、DOCX 二进制、Base64、脚本和任意代码字段。CommandRequest 只能携带定位、分类、摘要和完整 SHA-256 锚点。

## Control Plane 合同（v1）

- `control-endpoint-manifest.schema.json`：只允许 `127.0.0.1` 随机端口，携带 instance、PID、创建时间、Bearer token、server/contract version 与心跳。
- `control-job-request.schema.json`：版本化的 `HostSnapshot` 提交；拒绝未知顶层字段和调用方指定的可执行、脚本、模块或命令。
- `control-job-result.schema.json`：只返回 job/request/document/snapshot identity、识别结果、声明式 FormattingPlan、warnings 和脱敏 metrics。

TypeScript 由 `packages/control-client` 校验 endpoint 与 job/result；Python Control Server 在接收边界再次校验。Control Server 的内部 RecognitionPort 与 FormattingPlannerPort 只由本地白名单装配，绝不从请求 JSON 选择实现。

# 冻结合同

第一阶段冻结的 JSON Schema 版本均为 1.0：

- RecognitionResult
- CommandRequest
- FormattingCommandSet
- ClientCapabilities
- ExecutionResult

Schema 位于 schemas/，并禁止未知顶层字段、正文、完整路径、DOCX 二进制、Base64、脚本和任意代码字段。CommandRequest 只能携带定位、分类、摘要和完整 SHA-256 锚点。

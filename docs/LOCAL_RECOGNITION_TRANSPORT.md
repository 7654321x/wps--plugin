# 本地识别传输

开发期使用 local-agent，且仅监听 127.0.0.1 或 ::1。

接口：

- GET /v1/health
- GET /v1/version
- POST /v1/recognize

识别请求只向 loopback agent 传递 source_path；该路径仅用于读取本机已保存的 DOCX，永远不会进入 agent 响应、RecognitionResult 或 CommandRequest。Agent 调用 docxtool.sdk.recognize_docx，不复制识别规则，并在调用前后比较输入文件 SHA-256 以确认没有修改原文件。

开发启动示例：

~~~text
python -m docxtool_local_agent --port 0 --session-token <短期令牌>
~~~

正式 Native Launcher 不属于当前阶段。
# Local recognition transport

开发诊断页面不向浏览器注入 local-agent session token。页面只调用受限的 E2E loopback 端点；local-agent 在本机会话副本上保留 token 并内部调用识别与命令服务。返回值只包含状态、命令数量和哈希锚点，禁止正文、路径、文件名和原始请求响应。

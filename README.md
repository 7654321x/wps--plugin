# Docxtool WPS 第一阶段

本目录是独立于现有 Web 服务的 WPS 加载项工程。第一阶段已建立本地识别适配、脱敏协议、统一命令服务、声明式命令校验、Mock WPS 执行器和两个发行版装配。

识别 wheel 的公开入口为 docxtool.sdk.recognize_docx，CLI 为 docxtool-recognize。它只在用户电脑上运行；DOCX 和正文不发送到命令服务。

常用验证：

    npm run typecheck
    npm test
    ./.venv/Scripts/python.exe -m pytest command-service/tests local-agent/tests
    npm run verify:local-direct

当前仓库根目录固定为 `D:\PycharmProjects\wps`。默认不读写旧的 `D:\PycharmProjects\docxtool` 仓库。

## Worker-Orchestrated WPS Host Bridge

WPS 线程解耦正在按 Looper 微任务推进。真实 WPS 已确认支持同源 classic Worker；探针资源为 `pipeline-worker-probe.js`，往返实测 13 ms。

目标线程边界：Worker 持有流程状态机、哈希、命令生成、批次控制和识别协调；WPS 页面线程只执行不可移出的微型 JSAPI RPC。本地 `docxtool-recognize.exe` 继续负责 DOCX 识别。Worker 不得访问或接收 `Application`、`Document`、`Range` 等宿主对象，也不恢复 9528、local-agent 或 command-service。

P0 与 T8–T10 已完成：快照批次使用 Host duration 调整，诊断日志有界采样；识别 launch/probe/cancel、Worker 内命令生成和分批预览批注均有自动测试。正式 preview_document 的源码已切换到 Worker，但真实 WPS 证明 OAAssist.ShellExecute(exe, args) 会同步阻塞约 37.5 秒且没有启动识别进程，因此线程预览默认关闭并返回 THREADED_PREVIEW_RECOGNITION_LAUNCH_BLOCKED，不回退旧同步预览。正式 format_document 尚未切换，T12–T17 按停止条件未开始，当前状态为 BLOCKED。开发影子快照也已改为只能显式启动，不再自动读取普通打开文档。详细进度见 .runtime/looper-worker-host-bridge.md（本机状态文件，不提交）。

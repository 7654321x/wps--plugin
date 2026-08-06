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

### Local Job Broker

识别进程通过 `main.py` 管理的 `docxtool-job-broker.exe` 启动。WPS Host 只在 `%APPDATA%\Docxtool\jobs\<uuid-v4>\` 写入 `request.json` 与 `queued.json`，Broker 原子领取任务，从受校验的 runtime 清单取得 recognizer 路径和 SHA-256，再以参数数组、`shell=False` 启动识别程序。Broker 只监听文件队列，不开放 HTTP、WebSocket 或 TCP 端口，也不读取 DOCX 正文或处理格式命令。

Broker 状态位于 `%APPDATA%\Docxtool\broker\status.json`，包含 PID、版本、runtime hash 和心跳；Host 会拒绝未运行、过期或 runtime 不匹配的 Broker。`npm run verify:local-direct` 会验证双 EXE 清单、安装 hash，并通过受管理脱敏 fixture 做一次真实 Broker → recognizer → result smoke。

P0 与 T8–T10 已完成：快照批次使用 Host duration 调整，诊断日志有界采样；识别 launch/probe/cancel、Worker 内命令生成和分批预览批注均有自动测试。当前正式线程预览识别启动边界已切换到无端口 Local Job Broker，旧 ShellExecute 识别链不再使用；Broker 独立冒烟和自动门禁通过。`threadedPreviewEnabled` 仍保持 `false`，因为真实 WPS 20/200/1000 识别与正式预览尚未验收，不能提前写 PASS，也不回退旧同步预览。正式 format_document 尚未切换，T12–T17 按停止条件未开始。开发影子快照也已改为只能显式启动，不再自动读取普通打开文档。详细进度见 `.runtime/looper-local-job-broker.md`（本机状态文件，不提交）。

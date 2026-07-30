# Docxtool WPS 第一阶段

本目录是独立于现有 Web 服务的 WPS 加载项工程。第一阶段已建立本地识别适配、脱敏协议、统一命令服务、声明式命令校验、Mock WPS 执行器和两个发行版装配。

识别 wheel 的公开入口为 docxtool.sdk.recognize_docx，CLI 为 docxtool-recognize。它只在用户电脑上运行；DOCX 和正文不发送到命令服务。

常用验证：

    npm run typecheck
    npm test
    ../.venv/Scripts/python.exe -m pytest command-service/tests
    ../.venv/Scripts/python.exe -m build command-service --wheel

真实 WPS API、Ribbon、任务窗格、安装器和云端部署不属于第一阶段。

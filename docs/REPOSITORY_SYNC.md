# 仓库事实源与发布关系

审计时间：2026-07-30

## 结论

本轮唯一开发事实源是 `D:\PycharmProjects\wps`。该目录是一个独立 Git 仓库，远端为 `7654321x/wps--plugin`。

旧的 `D:\PycharmProjects\docxtool` 不是本项目事实源。除非用户明确要求，只能把它作为只读外部来源或历史参照，不得写入、提交或推送。

## 开发与发布规则

- WPS 加载项、local-agent、command-service、协议和 WPS 自动验收代码只在 `D:\PycharmProjects\wps` 修改。
- `docxtool` wheel 通过本仓库 `.venv` 安装包使用；默认格式同步通过 `importlib.resources` 从本级已安装 wheel 读取，不依赖其他源码目录。
- `wps--plugin` 的 GitHub 远端是发布/镜像目标，不是覆盖本地事实源的来源。本轮不拉取覆盖、不提交、不推送。
- 对根项目默认格式的使用通过受控 profile 同步与只读比较完成；两份文件的 SHA-256 不同并不意味着可直接复制，因为它们的职责与 JSON 形状不同。

## 关键目录映射

| 能力 | 事实源 |
| --- | --- |
| DOCX 识别 SDK | `D:\PycharmProjects\wps\.venv\Lib\site-packages\docxtool\sdk` |
| 识别 decoder 与测试 | 本仓库通过已安装 wheel 调用，不直接修改 decoder 源码 |
| 默认公文格式 | 本级已安装 wheel 的 `docxtool.resources/config/default-format.json` |
| WPS JS 加载项 | `apps\classified-offline` |
| WPS 协议与执行器 | `packages`、`schemas` |
| 本地服务和 E2E | `local-agent`、`command-service`、`scripts` |

# 仓库事实源与发布关系

审计时间：2026-07-30

## 结论

本轮唯一开发事实源是 `D:\PycharmProjects\docxtool\wps`。该目录是一个独立 Git 仓库，当前基线为 `3e9ed1f6bb46c90b725e55738665bbf757c6cc1c`，远端为 `7654321x/wps--plugin`。

外层 `D:\PycharmProjects\docxtool` 是 recognition wheel 与 DOCX 排版引擎的工作树，审计时基线为 `9decd9520fab21c0d43987a479a581e4812fd297`，并且已有大量未提交改动。外层 Git 将 `wps/` 视为一个嵌套仓库；它不是本轮可被外层仓库覆盖的普通目录。

## 开发与发布规则

- WPS 加载项、local-agent、command-service、协议和 WPS 自动验收代码只在本目录修改。
- `docxtool` 只作为本地识别 SDK、默认格式与现有引擎能力的只读审计对象；本轮不修改其 Web 行为、DOCX 输出或 recognition wheel 规则。
- `wps--plugin` 的 GitHub 远端是发布/镜像目标，不是覆盖本地事实源的来源。本轮不拉取覆盖、不提交、不推送。
- 对根项目默认格式的使用通过受控 profile 同步与只读比较完成；两份文件的 SHA-256 不同并不意味着可直接复制，因为它们的职责与 JSON 形状不同。

## 关键目录映射

| 能力 | 事实源 |
| --- | --- |
| DOCX 识别 SDK | `..\src\docxtool\sdk` |
| 识别 decoder 与测试 | `..\src\docxtool\document\recognition`、`..\tests\test_recognition_decoder.py` |
| 默认公文格式 | `..\src\docxtool\resources\config\default-format.json` |
| WPS JS 加载项 | `apps\classified-offline` |
| WPS 协议与执行器 | `packages`、`schemas` |
| 本地服务和 E2E | `local-agent`、`command-service`、`scripts` |

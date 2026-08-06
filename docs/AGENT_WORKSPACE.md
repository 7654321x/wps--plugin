# Agent 工作资料布局

普通 Agent 说明文档与其他项目 Markdown 一并集中在 `docs/`。

项目规则正文、问题清单和交接记录分别位于 `AGENTS.md`、`问题清单Agent.md`、`交接文档.md`（均在本 `docs/` 目录）。仓库根目录只保留一个极短的 `AGENTS.md` 自动发现入口，指向本目录的权威规则正文。

审阅补丁位于 `../agent/reviews/`。`agent/` 是受管理目录，GitHub 发布时必须随源码、测试和 `docs/` 一起提交。根目录 `wps-plugin-debug.log` 是用户明确允许的唯一原始日志例外，必须先通过敏感信息扫描；其他日志、用户 DOCX、wheel 和本机产物仍统一放在被 Git 忽略的 `local_recycle/` 分类目录中。

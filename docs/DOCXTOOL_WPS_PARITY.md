# docxtool 与 WPS 插件能力差距矩阵

详细机器可读矩阵见同目录 `DOCXTOOL_WPS_PARITY.json`。审计依据为根项目的实际 engine/recognition 源码与测试，以及本仓库的 schemas、composition、executor、local-agent、command-service 和 WPS 加载项入口；没有以 README 代替源码审计。

## MVP 结论

| 范围 | 当前结论 | 本轮动作 |
| --- | --- | --- |
| 五类格式命令 | 已有命令生成、JS executor 和 line_only 网格基础，但主流程仍在收口 | 冻结 1.1 合同、强制生产 composition、目标定位、事务和读回 |
| 严格 22×28 网格 | WPS JSAPI 1.0.5 未证明完整可写/保存能力 | 保持 `line_only`；严格模式返回 `DOCUMENT_CHARACTER_GRID_UNSUPPORTED` |
| 根项目结构与文本能力 | root engine 已有大部分实现和测试 | 不修改 root；仅列入后续 parity 路线图 |
| 表格、图片复杂排版 | 根项目与插件都不是完整能力 | 明确 OUT_OF_SCOPE |

## 审计发现

- 根项目默认格式 JSON 与插件 profile 的 SHA-256 不同：根项目面向 Web/engine 的简化结构，插件 profile 是五类命令的规范化展开；不能直接覆盖。
- 原插件存在单一 `PROTOCOL_VERSION`、全局 `Record<string, unknown>` arguments、生产 composition 和 Mock 同文件、以及 fixture E2E driver 等主流程风险。
- root 工作树当前有用户已有未提交修改；本轮不修改 root 文件，也不从 GitHub 覆盖本地。

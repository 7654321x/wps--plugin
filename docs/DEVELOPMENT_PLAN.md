# Docxtool WPS 插件总体架构规划

## 2026-08-06 Control Server 迁移状态（v1.4.0）

已完成 C0–C4、C6、C7 的基础设施：`control-server/` 提供随机 loopback HTTP、Bearer token、endpoint manifest、instance/PID/创建时间/版本/合同/心跳校验、单 active + 单 queued Job Store、取消和超时；`packages/control-client` 提供 Dedicated Worker 使用的 Local HTTP ControlTransport；Worker 可通过显式 `control_endpoint` 配置进入控制面路径。C5 的受校验 runtime RecognitionPort 尚未接入，服务会如实报告该能力未配置。

当前不自动打开 `controlServerEnabled`，也未切换正式 preview/format。原因是生产 RecognitionPort 必须继续复用受校验的 `docxtool-recognize.exe`/Broker，并先完成 C5 shadow、C14 diagnostic 20/200/1000 与真实 WPS 保存证据。下一步严格顺序：C5 RecognitionPort → C6 FormattingPort 联调 → C7 shadow 对照 → C8–C13 Worker/Host/自动门禁 → C14–C16 真实 WPS。

## 一、产品目标

WPS 插件负责读取当前打开的文档，在用户电脑上完成文档识别，再向命令服务请求排版命令，最后通过 WPS API 直接修改当前文档。

文档正文和 DOCX 文件始终留在用户电脑上。

系统提供两个发行版本。

### 1. 涉密离线版

```text
WPS 当前文档
→ 本地文档快照
→ 本地 recognition wheel
→ RecognitionResult
→ 本地命令服务
→ FormattingCommandSet
→ WPS API 执行
```

特点：

- 不上传 DOCX；
- 不上传识别结果；
- 不连接云端业务服务；
- 识别服务和命令服务均随安装包部署到本机；
- 使用离线授权；
- 使用离线更新包；
- 不包含遥测、云端日志和在线更新模块。

### 2. 标准联网版

```text
WPS 当前文档
→ 本地文档快照
→ 本地 recognition wheel
→ RecognitionResult
→ 云端命令服务
→ FormattingCommandSet
→ WPS API 执行
```

特点：

- DOCX 不上传；
- 文档正文不上传；
- 只上传经过脱敏的 RecognitionResult；
- 云端服务负责模板、单位规则、命令生成和授权；
- WPS API 仍然在用户电脑上执行；
- 可支持在线模板更新、授权和版本管理。

## 二、核心设计原则

### 1. 识别只有一套

两个版本都使用同一个 recognition wheel。

识别 wheel 是以下能力的唯一事实源：

- 文种识别；
- 主标题和续行标题；
- 发文字号；
- 主送机关；
- 正文；
- 一至四级标题；
- 会议元数据；
- 落款和日期；
- 附件；
- 嵌入文档；
- 置信度和复核信息。

涉密版和联网版不得各自维护识别规则。

### 2. 命令生成只有一套

命令服务核心只维护一份。

同一份命令服务代码可以：

- 打包成本地 EXE；
- 部署为局域网服务；
- 部署为云端服务。

部署位置不同，但输入、输出和命令逻辑完全一致。

### 3. WPS API 执行只有一套

所有真实 WPS API 调用只能存在于客户端的 `WpsApiExecutor` 中。

命令服务不得：

- 直接调用 WPS API；
- 返回任意 JavaScript；
- 返回 `Application.ActiveDocument` 一类对象表达式；
- 要求插件使用 `eval`；
- 依赖某个具体 WPS 版本的数字枚举。

命令服务只返回语义化、声明式命令。

### 4. 模块通过接口连接

业务流程只依赖抽象接口，不直接依赖具体实现。

主要接口包括：

- `DocumentReader`：读取当前 WPS 文档；
- `RecognitionProvider`：调用本地识别 wheel；
- `CommandServiceClient`：请求本地或云端命令服务；
- `CommandValidator`：检查服务器返回的命令；
- `DocumentExecutor`：调用 WPS API；
- `TransactionManager`：管理撤销和失败回滚；
- `CapabilityProvider`：报告当前 WPS API 能力；
- `EndpointProvider`：提供本地或云端服务地址；
- `LicenseProvider`：提供离线或在线授权。

## 三、完整调用流程

### 1. 插件读取当前文档

插件通过 WPS API 获取当前活动文档，并生成本地文档快照。

快照可以是：

- 临时 DOCX；
- WPS API 提取的结构化数据；
- Flat OPC 或其他可供识别 wheel 使用的格式。

第一版建议优先使用临时 DOCX，以最大限度复用现有识别 wheel。

### 2. 本地识别

本地 Agent 调用 recognition wheel，产生统一的 `RecognitionResult`。

RecognitionResult 包含：

- 文档模式；
- 段落识别类型；
- 段落所属板块；
- 段落定位信息；
- 文本哈希；
- 文本长度；
- 置信度；
- 是否需要复核；
- 识别引擎版本。

RecognitionResult 保存在用户本机。

### 3. 请求命令

插件将 RecognitionResult、排版模板、客户端能力和协议版本交给命令服务。

涉密版发送到：

```text
127.0.0.1 上的本地命令服务
```

联网版发送到：

```text
固定 HTTPS 云端命令服务
```

两者使用完全相同的请求协议。

### 4. 生成命令

命令服务根据：

- RecognitionResult；
- 排版模板；
- 单位配置；
- 客户端 WPS 能力；
- 产品授权；
- 命令协议版本；

生成 `FormattingCommandSet`。

### 5. 客户端校验

插件收到命令后依次检查：

- JSON Schema；
- 命令协议版本；
- 命令白名单；
- 参数范围；
- 客户端能力；
- 文档 revision；
- 目标段落哈希；
- 服务响应签名；
- 请求 ID 是否一致。

### 6. WPS 原位执行

插件开启一次事务或自定义撤销记录，调用 WPS API 修改当前文档。

成功后，用户可以一次撤销整次排版。

失败时，插件撤销已执行的操作，不能留下半排版状态。

---

# 四、建议目录结构

```text
wps/
├── README.md
├── package.json
├── tsconfig.base.json
├── workspace.yaml
│
├── apps/
│   ├── classified-offline/
│   └── standard-online/
│
├── packages/
│   ├── contracts/
│   ├── application/
│   ├── ui/
│   ├── wps-adapter/
│   ├── recognition-client/
│   ├── command-service-client/
│   ├── launcher-client/
│   ├── security/
│   └── diagnostics/
│
├── local-agent/
├── command-service/
├── schemas/
├── build/
├── installer/
├── tests/
└── docs/
```

---

# 五、根目录文件职责

## `wps/README.md`

WPS 项目的总入口文档。

负责说明：

- 产品目标；
- 涉密版和联网版区别；
- 总体目录结构；
- 开发环境；
- 构建方式；
- 测试方式；
- 当前支持的 WPS 版本；
- 当前尚未实现的功能。

## `wps/package.json`

WPS 前端工作区的统一依赖和脚本定义。

负责管理：

- TypeScript；
- 测试工具；
- JSON Schema 验证；
- 构建脚本；
- 两个插件版本的打包命令。

## `wps/tsconfig.base.json`

所有 TypeScript 包共用的编译设置。

负责统一：

- 语法目标；
- 模块格式；
- 严格类型检查；
- 路径别名；
- 源码映射；
- 不同包之间的引用规则。

## `wps/workspace.yaml`

管理 WPS 项目内部多个包。

负责声明：

- apps；
- packages；
- 公共工具；
- 各模块之间的本地依赖。

---

# 六、两个插件入口

## `apps/classified-offline/`

涉密离线版的装配入口。

该目录不实现业务逻辑，只决定使用哪些具体组件。

### `ribbon.xml`

定义涉密版 WPS 功能区。

包含：

- 一键排版；
- 仅识别；
- 复核结果；
- 恢复；
- 设置；
- 关于。

涉密版名称、图标和视觉标识应与联网版明显区分。

### `src/main.ts`

涉密版插件启动入口。

负责：

- 初始化插件；
- 注册 Ribbon 回调；
- 初始化任务窗格；
- 装配涉密版依赖；
- 检查本地 Agent；
- 检查离线许可证。

### `src/composition-root.ts`

涉密版依赖装配文件。

负责将接口绑定为：

- 本地识别客户端；
- 本地命令服务地址；
- 离线授权；
- 无遥测实现；
- 无在线更新实现；
- 共用 WPS API 执行器。

### `src/edition-config.ts`

涉密版静态配置。

负责定义：

- 产品版本；
- 插件 ID；
- 安装版本；
- 本地服务模式；
- 是否允许网络；
- 日志策略；
- 更新策略；
- 授权模式。

该文件只能保存非敏感配置。

## `apps/standard-online/`

标准联网版的装配入口。

结构与涉密版相同，但装配方式不同。

### `ribbon.xml`

定义联网版 WPS 功能区。

### `src/main.ts`

联网版插件启动入口。

### `src/composition-root.ts`

负责绑定：

- 本地识别客户端；
- 云端命令服务客户端；
- 在线授权；
- 可选遥测；
- 在线更新；
- 共用 WPS API 执行器。

### `src/edition-config.ts`

定义：

- 云端 API 地址；
- 产品版本；
- 插件 ID；
- 网络超时；
- 授权模式；
- 更新通道；
- 是否允许离线宽限。

---

# 七、公共合同包

## `packages/contracts/`

保存客户端、本地服务和云端服务共同遵循的数据结构。

该包不得依赖 WPS API、HTTP 框架或 Python 实现。

### `document-snapshot.ts`

定义文档快照的结构。

用于描述：

- 文档 ID；
- revision；
- 段落；
- run；
- 节；
- 表格；
- 图片；
- 页眉页脚；
- 页面设置；
- 当前 WPS 能力。

文档快照原则上只在用户端使用。

### `recognition-result.ts`

定义识别 wheel 输出的统一结构。

用于描述：

- 文档模式；
- 每段类型；
- 板块；
- 哈希；
- 长度；
- 置信度；
- 复核状态；
- 识别版本。

### `command-request.ts`

定义插件发送给命令服务的请求。

包含：

- 请求 ID；
- 协议版本；
- RecognitionResult；
- 模板 ID；
- 模板版本；
- 客户端能力；
- 产品版本；
- 授权范围。

### `formatting-command.ts`

定义命令服务返回的命令。

命令只表达语义，不包含 WPS API 对象或任意脚本。

### `client-capabilities.ts`

定义当前客户端支持的能力。

例如：

- 段落格式；
- 页面设置；
- 多级编号；
- 页眉页脚；
- 表格；
- 图片；
- 域；
- 事务撤销。

### `execution-result.ts`

定义 WPS 执行结果。

包含：

- 成功命令数；
- 跳过命令数；
- 失败命令；
- 警告；
- 事务 ID；
- 是否回滚；
- 当前文档 revision。

### `errors.ts`

定义跨模块稳定错误码。

禁止直接把底层异常文本当成接口错误。

### `versions.ts`

集中管理：

- RecognitionResult 版本；
- CommandRequest 版本；
- FormattingCommandSet 版本；
- 客户端能力版本。

### `index.ts`

公共合同包的统一导出入口。

---

# 八、应用编排层

## `packages/application/`

负责完整的“一键排版”业务流程，不直接操作 WPS API，也不直接发送 HTTP。

### `ports.ts`

定义应用层依赖的全部接口。

包括：

- DocumentReader；
- RecognitionProvider；
- CommandServiceClient；
- CommandValidator；
- DocumentExecutor；
- TransactionManager；
- CapabilityProvider；
- LicenseProvider。

### `format-document-usecase.ts`

编排一键排版。

负责按顺序执行：

- 检查文档；
- 创建快照；
- 本地识别；
- 请求命令；
- 校验命令；
- 创建事务；
- 执行命令；
- 验证结果；
- 返回摘要。

### `recognize-document-usecase.ts`

实现“仅识别”。

只生成 RecognitionResult，不请求命令，也不修改文档。

### `review-result-usecase.ts`

负责整理需要用户复核的识别结果。

### `restore-document-usecase.ts`

负责触发撤销或恢复流程。

### `application-context.ts`

保存一次任务中的上下文。

包括：

- 当前文档 ID；
- revision；
- 请求 ID；
- 识别版本；
- 模板版本；
- 服务端版本；
- 事务 ID。

### `application-errors.ts`

把各基础设施错误转换为用户可以理解的稳定业务错误。

---

# 九、WPS 用户界面

## `packages/ui/`

只负责界面和用户交互，不处理识别、命令生成或格式执行。

### `ribbon-actions.ts`

处理 Ribbon 按钮事件，并调用应用层 UseCase。

### `taskpane-controller.ts`

控制任务窗格的打开、关闭和内容切换。

### `progress-model.ts`

管理识别、请求命令、应用格式等阶段的进度状态。

### `review-model.ts`

整理低置信度段落和不支持的命令。

### `notifications.ts`

统一管理成功、警告和错误提示。

### `settings-controller.ts`

管理：

- 排版模板选择；
- 自动保存；
- 复核策略；
- 日志设置；
- 版本信息。

---

# 十、WPS API 适配层

## `packages/wps-adapter/`

唯一允许调用 WPS API 的模块。

### `document-reader.ts`

读取当前活动文档。

负责：

- 检查是否存在活动文档；
- 检查文档类型；
- 读取保存状态；
- 生成临时快照；
- 获取文档基本信息。

### `document-fingerprint.ts`

生成当前文档 revision。

用于判断识别期间文档是否被用户修改。

### `target-locator.ts`

根据命令目标定位当前文档中的：

- 段落；
- 节；
- 表格；
- 图片；
- 页眉页脚；
- 域。

定位时综合使用：

- 段落 ID；
- 索引；
- Range；
- 文本哈希；
- 文本长度；
- occurrence index。

### `capability-detector.ts`

检测当前 WPS 版本实际支持的 API。

输出统一的 ClientCapabilities。

### `command-registry.ts`

维护允许执行的命令白名单，并将命令名称映射到本地处理器。

### `command-executor.ts`

按顺序执行 FormattingCommandSet。

负责：

- 调用命令处理器；
- 记录结果；
- 处理跳过项；
- 捕获失败；
- 生成 ExecutionResult。

### `transaction-manager.ts`

负责：

- 开启一次自定义撤销记录；
- 提交事务；
- 出错时撤销；
- 防止部分成功；
- 保存事务 ID。

### `handlers/paragraph.ts`

处理：

- 字体；
- 字号；
- 粗体；
- 对齐；
- 缩进；
- 行距；
- 段距；
- 段落样式。

### `handlers/section.ts`

处理：

- 页面大小；
- 页面方向；
- 页边距；
- 装订线；
- 分节设置；
- 页眉页脚距离。

### `handlers/numbering.ts`

处理：

- 一级至四级编号；
- 多级列表模板；
- 编号字体；
- 编号缩进；
- 编号续接。

### `handlers/header-footer.ts`

处理：

- 页眉；
- 页脚；
- 页码；
- 首页不同；
- 奇偶页不同。

### `handlers/table.ts`

处理表格布局和格式。

### `handlers/image.ts`

处理图片大小、位置和环绕方式。

### `handlers/field.ts`

处理页码域、目录和其他可支持的域。

### `index.ts`

WPS 适配包统一导出入口。

---

# 十一、本地识别客户端

## `packages/recognition-client/`

负责调用本机 recognition wheel。

### `recognition-provider.ts`

定义识别接口。

### `local-agent-client.ts`

通过本地 Agent 调用 recognition wheel。

该文件不关心 recognition wheel 内部实现。

### `snapshot-request-builder.ts`

把文档快照转换为本地 Agent 可以处理的请求。

### `result-normalizer.ts`

把 wheel 返回结果转换为统一 RecognitionResult。

### `recognition-version-checker.ts`

检查：

- wheel 版本；
- RecognitionResult 协议版本；
- 插件支持范围。

---

# 十二、命令服务客户端

## `packages/command-service-client/`

插件只通过该包访问命令服务。

### `command-service-client.ts`

定义统一命令服务接口。

本地和云端使用同一接口。

### `http-client.ts`

实现统一 HTTP 请求。

负责：

- 请求序列化；
- 超时；
- 取消；
- 稳定错误转换；
- 响应读取。

### `endpoint-provider.ts`

定义服务地址来源接口。

### `local-endpoint-provider.ts`

从本地 launcher 获取：

- 随机端口；
- 会话令牌；
- 服务版本；
- 启动时间。

仅涉密版使用。

### `cloud-endpoint-provider.ts`

提供固定云端 API 地址。

仅联网版使用。

### `request-builder.ts`

构造 CommandRequest，并移除禁止上传的信息。

### `response-validator.ts`

验证命令服务响应。

### `response-verifier.ts`

验证服务端响应签名、请求 ID 和有效期。

### `retry-policy.ts`

定义网络重试策略。

本地服务和云端服务可以使用不同的重试参数，但共用同一抽象。

---

# 十三、本地服务启动器

## `packages/launcher-client/`

用于管理本地 Agent 和本地命令服务。

### `launcher-client.ts`

定义启动器接口。

### `local-service-launcher.ts`

负责：

- 检查服务是否运行；
- 启动服务；
- 取得端口；
- 取得会话令牌；
- 检查服务版本；
- 请求服务退出。

### `service-session.ts`

保存本地服务会话信息。

### `heartbeat.ts`

维持插件和本地服务之间的心跳。

---

# 十四、客户端安全模块

## `packages/security/`

### `command-policy.ts`

规定允许的命令和参数范围。

### `schema-validator.ts`

执行 JSON Schema 校验。

### `endpoint-policy.ts`

限制：

- 涉密版只能访问 loopback；
- 联网版只能访问固定 HTTPS 域名；
- 禁止任意用户输入服务地址。

### `session-token-store.ts`

保存本地服务短期会话令牌。

### `response-signature.ts`

验证云端命令响应签名。

### `redaction.ts`

对日志和诊断数据脱敏。

### `content-policy.ts`

禁止普通一键排版执行正文修改操作。

---

# 十五、诊断模块

## `packages/diagnostics/`

### `logger.ts`

统一日志接口。

### `event-types.ts`

定义稳定诊断事件。

### `redactor.ts`

删除：

- 正文；
- 文件完整路径；
- 用户敏感信息；
- 许可证明文。

### `execution-report.ts`

生成本地排版报告。

### `no-op-telemetry.ts`

涉密版使用的空遥测实现。

### `online-telemetry.ts`

联网版可选的脱敏遥测实现。

---

# 十六、本地 Agent

## `local-agent/`

本地 Agent 是插件和 Python wheel 之间的桥梁，两个版本都需要。

### `pyproject.toml`

定义 Agent 自身依赖和 Python 版本。

### `src/docxtool_local_agent/__main__.py`

本地 Agent 启动入口。

### `app.py`

组装本地 Agent 的 HTTP 或 IPC 服务。

### `api/health.py`

提供健康检查。

### `api/session.py`

创建和验证本机会话。

### `api/recognize.py`

接收本地识别请求，并调用 recognition wheel。

### `recognition/wheel_loader.py`

加载和验证 recognition wheel。

### `recognition/runner.py`

调用 wheel 的统一识别入口。

### `recognition/result_mapper.py`

把 wheel 结果映射为 RecognitionResult。

### `snapshot/storage.py`

管理临时 DOCX 和识别任务目录。

### `snapshot/fingerprint.py`

生成快照哈希和文档 revision。

### `snapshot/cleanup.py`

成功、失败和超时后清理临时文件。

### `storage/result_store.py`

本地保存短期 RecognitionResult。

建议使用：

- 内存或临时目录；
- 明确 TTL；
- 不长期保存段落明文；
- 服务退出时清理。

### `security/loopback.py`

确保服务只监听回环地址。

### `security/session_token.py`

生成和验证随机会话令牌。

### `lifecycle/single_instance.py`

防止启动多个 Agent 实例。

### `lifecycle/idle_shutdown.py`

空闲一段时间后自动退出。

### `config.py`

读取 Agent 本地配置。

### `errors.py`

定义稳定错误码。

---

# 十七、统一命令服务

## `command-service/`

这是本地部署和云端部署共同使用的唯一命令服务。

### `pyproject.toml`

定义命令服务依赖。

命令核心不得依赖 WPS API。

### `src/docxtool_command_service/__main__.py`

命令服务启动入口。

### `core/contracts.py`

定义服务内部使用的数据模型。

### `core/command_builder.py`

命令生成核心。

根据 RecognitionResult 和模板生成 FormattingCommandSet。

### `core/profile_loader.py`

加载排版模板和单位配置。

### `core/profile_registry.py`

管理模板 ID、模板版本和兼容性。

### `core/capability_matcher.py`

根据客户端能力删除、降级或标记不支持的命令。

### `core/command_policy.py`

限制命令类型和参数范围。

### `core/validation.py`

验证请求和生成后的命令。

### `core/version.py`

管理命令服务、模板和协议版本。

### `api/app.py`

组装 HTTP API。

本地部署和云端部署使用同一应用入口。

### `api/routes/commands.py`

实现命令生成接口。

### `api/routes/health.py`

健康检查接口。

### `api/routes/capabilities.py`

返回服务支持的协议和命令能力。

### `api/routes/version.py`

返回服务版本。

### `api/auth/local_auth.py`

本地部署使用的会话令牌认证。

### `api/auth/cloud_auth.py`

云端部署使用的访问令牌或签名认证。

### `adapters/local_config.py`

读取涉密版本地配置和离线许可证。

### `adapters/cloud_config.py`

读取云端环境配置。

### `profiles/default.json`

默认公文排版模板。

### `profiles/schema.json`

排版模板 Schema。

命令模板和识别规则应分离管理。

---

# 十八、协议 Schema

## `schemas/recognition-result.schema.json`

验证 RecognitionResult。

## `schemas/command-request.schema.json`

验证插件发送给命令服务的请求。

## `schemas/formatting-command-set.schema.json`

验证命令服务返回的命令集合。

## `schemas/client-capabilities.schema.json`

验证客户端能力。

## `schemas/execution-result.schema.json`

验证执行结果。

Schema 是客户端、本地服务和云端服务之间的协议事实源。

---

# 十九、构建系统

## `build/configs/classified-offline.json`

定义涉密版构建内容。

明确排除：

- 云端地址；
- 在线授权；
- 在线更新；
- 遥测；
- 远程日志；
- Cloudflare 相关内容。

## `build/configs/standard-online.json`

定义联网版构建内容。

## `build/scripts/build-addin.*`

构建 WPS 加载项。

## `build/scripts/build-local-agent.*`

构建本地 Agent。

## `build/scripts/build-command-service.*`

构建本地命令服务或云端服务包。

## `build/scripts/package-classified.*`

生成涉密版完整安装产物。

## `build/scripts/package-online.*`

生成联网版完整安装产物。

## `build/scripts/verify-artifacts.*`

验证：

- 不应包含的模块；
- 文件哈希；
- 版本；
- 签名；
- 协议 Schema；
- 依赖清单。

---

# 二十、安装器

## `installer/classified-offline/`

涉密版安装器。

安装：

- WPS 加载项；
- 本地 Agent；
- recognition wheel；
- 本地命令服务；
- 本地模板；
- 离线许可证组件；
- 卸载程序。

## `installer/standard-online/`

联网版安装器。

安装：

- WPS 加载项；
- 本地 Agent；
- recognition wheel；
- 云端命令客户端；
- 在线授权组件；
- 更新组件；
- 卸载程序。

联网版不需要安装本地命令服务。

---

# 二十一、测试目录

## `tests/contracts/`

测试 TypeScript、Python 和 JSON Schema 对同一协议的理解一致。

## `tests/recognition/`

测试 recognition wheel 与插件 RecognitionResult 映射。

## `tests/command-service/`

测试本地和云端部署生成相同命令。

## `tests/wps-adapter/`

测试 WPS API 命令映射。

## `tests/security/`

测试：

- 命令白名单；
- 参数越界；
- 任意代码拒绝；
- 非 loopback 地址拒绝；
- 明文正文上传阻止；
- 会话令牌；
- 响应签名。

## `tests/integration/`

测试完整业务流程。

## `tests/e2e/`

在真实 WPS 环境中验证：

- 一键排版；
- 当前文档原位变化；
- 一次撤销；
- 本地命令服务；
- 云端命令服务；
- 断网提示；
- 服务失败恢复。

## `tests/fixtures/`

保存脱敏、可公开的测试文档和预期结果。

---

# 二十二、文档目录

## `docs/ARCHITECTURE.md`

记录总体架构和模块边界。

## `docs/COMMAND_PROTOCOL.md`

记录全部命令名称、参数和版本策略。

## `docs/RECOGNITION_PROTOCOL.md`

记录 RecognitionResult 协议。

## `docs/SECURITY_BOUNDARIES.md`

记录涉密版和联网版安全边界。

## `docs/EDITIONS.md`

记录两个产品版本的差异。

## `docs/WPS_CAPABILITY_MATRIX.md`

记录不同 WPS 版本支持的 API。

## `docs/LOCAL_SERVICE.md`

记录本地 Agent 和本地命令服务的生命周期。

## `docs/RELEASE_PROCESS.md`

记录构建、签名、发布和回滚流程。

---

# 二十三、当前明确不做的内容

第一阶段不引入：

- Cloudflare Workers；
- Cloudflare Pages；
- Cloudflare Tunnel；
- Cloudflare 配置文件；
- 网页前端；
- 管理后台；
- WebSocket 推送；
- 任意代码下发；
- 服务器直接调用 WPS API。

后续需要公网 WAF、限流或隐藏源站时，可以在云端命令服务前增加 Cloudflare，但不修改：

- RecognitionResult；
- CommandRequest；
- FormattingCommandSet；
- WPS API执行器；
- 命令服务核心。

---

# 二十四、最终架构结论

整个产品不是两套业务代码，而是：

```text
一个 WPS 插件公共核心
一个本地识别 Agent
一个 recognition wheel
一个命令服务核心
一个 WPS API执行器
两个插件装配入口
两种命令服务部署位置
两个安装包
```

涉密版：

```text
插件 + 本地 Agent + recognition wheel + 本地命令服务
```

联网版：

```text
插件 + 本地 Agent + recognition wheel + 云端命令服务
```

两个版本唯一的核心差别是：

```text
命令服务 Endpoint
授权方式
更新方式
遥测策略
安装内容
```

识别、命令协议、命令生成逻辑和 WPS API执行逻辑全部共用。

# DocxTool WPS 问题清单 Agent

## 使用规则

本文件是 WPS 插件的持续防复发检查器。每次任务开始先检查相关条目，代码修改后逐项验证；发现新的可复发问题时，在任务结束前新增条目。只有满足条目中的自动验证门槛，才可在交接文档中写为通过。

## P001 批注泄露内部元数据

- 症状：WPS 批注显示 session、文档身份哈希、段落索引、anchor、Range 起止位置或内部 marker。
- 根因：把所有权与清理所需的内部字段直接拼入用户可见的批注正文。
- 禁止：在批注正文中写入调试字段、路径、令牌、哈希、内部代码或协议结构。
- 正确方案：批注正文只保留用户需要的识别结果和格式字段；所有权数据留在插件内存跟踪器中，以完整内容和段落 Range 联合校验。
- 自动验证门槛：单元测试断言可见字段完整、内部字段不存在；真实 WPS 保存后的 `comments.xml` 再次检查可见内容。

## P002 只做 WPS 内存读回，没有检查保存后的 DOCX

- 症状：JSAPI `Comments.Add`、字体或段落属性即时读回成功，但保存后批注或格式消失。
- 根因：把宿主内存状态误当成最终 DOCX 状态；WPS 保存时可能过滤字符、重算 Range 或转换单位。
- 禁止：用“赋值未抛异常”、Mock、即时读回代替保存后 OOXML 检查。
- 正确方案：每项真实能力都执行“写入 → 即时读回 → 保存 → 重新读取 DOCX/OOXML → 恢复或保留验收副本”。
- 自动验证门槛：真实 WPS PASS、保存后检查 PASS、正文 SHA-256 和段落顺序不变三者同时成立。

## P003 使用不可见控制字符承载批注所有权

- 症状：内存中批注存在且读回成功，保存后整条批注丢失。
- 根因：WPS 保存 DOCX 时会过滤或拒绝部分不可见 Unicode 控制字符。
- 禁止：使用零宽字符、不可见分隔符、Unicode 控制字符或其他未经过真实保存验证的隐藏载荷。
- 正确方案：DOCX 中只保存正常可见文本；内部所有权信息保存在插件跟踪器，不写入批注正文。
- 自动验证门槛：保存后的预览副本中 DocxTool 批注数量大于 0，内容字段完整；最终副本中 DocxTool 批注为 0，用户批注数量不变。

## P004 旧 WPS 宿主缓存旧构建或旧会话令牌

- 症状：新会话停在 bootstrap、回调超时，或 local-agent 返回 `UNAUTHORIZED`；代码和服务本身测试正常。
- 根因：测试文档被交给仍在运行的旧 WPS WebView，旧页面继续使用旧 build id、端口或 session token。
- 禁止：遇到超时就直接修改业务逻辑；不得在存在用户可见文档窗口时强制结束全部 WPS 进程。
- 正确方案：先核对 build id、会话 ID、进程启动时间和窗口标题；main 加载 build-info 时使用启动 nonce，其余 profile/runtime/Ribbon/Host 子资源使用 build id 查询参数，任务窗格按 `host_build` 动态导入对应 workflow，禁止固定 URL 命中旧 bundle。只关闭脱敏测试窗口；若所有 WPS 进程均无可见文档，再完整重启 WPS 宿主。
- 自动验证门槛：源码和 production dist 检查子资源版本参数；同一会话中 `main_script_loaded`、`host_router_installed`、`health_check`、`preview_document`、`one_click_format` 均有真实回报。

## P005 预览证据复制与 WPS 异步保存竞争

- 症状：宿主报告预览 PASS，但复制出的 `02-preview-comments.docx` 没有预览批注；稍后最终文档正常。
- 根因：WPS 可能先返回 `Saved=true`，随后才完成 DOCX 包替换；或一键排版清理先于证据复制。
- 禁止：仅凭宿主状态立刻复制文件并认定证据有效。
- 正确方案：预览保存后等待文件写入稳定，再发布预览完成状态；证据复制后必须立即读取 OOXML 确认批注数量和内容。
- WPS 若在批注变更后仍错误报告 `Saved=true`，受控 E2E 驱动必须先将脱敏测试文档标记为未保存，再调用正式 `Save()`；此操作不得用于用户真实文档。
- 自动验证门槛：预览副本 OOXML 检查明确识别至少一条 DocxTool 批注，并确认用户批注数量与基线一致。

同一规则也适用于最终副本：自动驱动必须等待最终保存稳定信号，不能仅看到 `one_click_format=PASS` 就立即读取工作文件。

## P006 用户可见单位和内部协议单位混用

- 症状：段前/段后显示磅，或固定行距显示 `pt`，与用户界面和公文习惯不一致。
- 根因：直接把协议字段名或内部单位输出到 UI。
- 禁止：擅自换算、混用或省略用户指定单位。
- 正确方案：段前、段后显示“行”；固定行距显示“磅”；字号优先显示“二号、三号”等中文字号。内部协议仍使用冻结的数值字段。
- 自动验证门槛：批注文案测试覆盖“段前：0 行”“段后：0 行”“固定行距：28 磅”“字号：二号”，并断言错误单位不存在。

## P007 wheel 与 WPS 段落序号在空段处错位

- 症状：长正文被标成一级标题，真正的一级标题被标成正文；空段之后所有批注整体偏移一段。
- 根因：wheel 可能按非空段落输出紧凑序号，WPS `Document.Paragraphs` 包含空段；直接用 `source_paragraph_index` 连接会错位。
- 禁止：在 WPS 端根据段落文字重新写一套标题分类器；不得用“索引加一/减一”硬编码修补单个文档。
- 正确方案：优先使用 wheel 输出的 `text_sha256`、前后文哈希和文档顺序，将 block 单调对齐到 WPS 段落；仅对无哈希旧 wheel 使用非空序号兼容分支。
- 自动验证门槛：包含标题、标题续行、空段、正文、一级标题的 fixture 中，空段后的正文仍为 `body`、一级标题仍为 `heading1`；真实文档只读审计的非空 block 均能按哈希映射。

## P008 不同格式的批注颜色无法区分

- 症状：主标题、一级标题和正文批注全部使用同一颜色，用户难以快速扫描。
- 根因：所有预览批注沿用同一个 WPS 当前用户作者；WPS 按批注作者分配颜色。
- 禁止：为颜色预览直接修改正文 `Font.Color`、高亮或底纹；这会污染正文格式和回滚日志。
- 正确方案：使用官方可写 `Comment.Author` / `Comment.Initial`，按识别角色设置 `DocxTool·主标题`、`DocxTool·一级标题`、`DocxTool·正文` 等作者。删除批注即可完整清理颜色预览。
- 自动验证门槛：保存后的预览 DOCX 至少包含三个不同的 `DocxTool·` 角色作者；最终副本中 DocxTool 批注为 0，用户批注保持不变。

## P009 服务重启后 WPS 报 UNAUTHORIZED

- 症状：local-agent 和 command-service 健康，但任务窗格显示 `失败：UNAUTHORIZED`。
- 根因：重新执行 prepare 会生成新的 session token；已打开的 WPS WebView 仍缓存旧 token。旧架构还让 WPS 分别访问 9528/9529，增加了双进程 token 不一致风险。
- 禁止：测试期间无必要地反复 prepare、停止常驻服务或只重启服务不重启 WPS。
- 正确方案：默认保持 3889 和 9528 常驻并复用当前会话。WPS 的识别和命令都通过 9528 统一入口；命令生成直接复用正式 command-service 核心，不启动第二个本机 HTTP 服务。确需轮换 token 时，先正常关闭所有 WPS 文档窗口，确认无可见窗口后结束残留 WPS 进程，再打开工作副本。
- 启动脚本必须把 token 保存在 `.runtime/e2e/session-token.txt`。prepare 先用同一 token 对 9528 的 `/v1/recognize` 与 `/v1/commands` 做鉴权探测；均一致则复用服务和 PID，不一致才重启 9528 统一服务。
- 自动验证门槛：`e2e:classified:status` 中静态资源、本地统一服务、命令接口和注册均为 PASS；9529 不再监听；新 WPS 宿主能上报当前 session。

## P010 wheel 内部对象类型进入冻结协议

- 症状：真实文档识别成功，但预览排版显示 `COMMAND_SERVICE_400` 或 `INVALID_SCHEMA`。
- 根因：wheel 的 `__object_caption__` 是有效段落 block，却未在唯一适配边界映射为冻结协议的 `caption`；命令服务因此拒绝未知类型。
- 禁止：在 WPS UI、executor 或命令服务中增加旧字段 fallback；不得把所有未知角色静默改成正文掩盖合同错误。
- 正确方案：只在 `LocalWheelRecognitionProvider` 的 wheel→协议适配表中将 `__object_caption__` 映射为 `caption`；无段落索引的 `__table__` 继续不进入段落合同。
- 自动验证门槛：适配器单测断言映射结果为 `caption`；真实识别结果经过命令接口不再返回 400；任务窗格真实预览可生成批注。

## P011 wheel 逻辑块序号被误当成 WPS 物理段落序号

- 症状：主标题续行批注落在一级标题和导语上；二级标题批注落在长正文上；表格单元格中的普通测试文字被标成落款日期、标题或其他无关角色；文档后半段错位更明显。
- 根因：wheel 的 structural importer 会把同一 Word 物理段落内的手工换行和“标题。正文”拆成多个逻辑块，并把表格整体表示为一个无段落索引的结构块。WPS `Document.Paragraphs` 则包含表格单元格段落。当前 `source_paragraph_index` 实际是 wheel 扁平逻辑块序号；适配器在哈希无法匹配整段时又把它当成 WPS 物理段落序号回退，导致跨粒度错位。
- 禁止：哈希不匹配时按裸序号回退；不得把未匹配表格单元格默认关联到相邻 wheel block；不得在定位已错位时据此判断 wheel 分类器错误或继续训练分类规则。
- 正确方案：wheel/SDK 必须输出原始物理段落稳定锚点以及逻辑块在该物理段落内的起止偏移；`block_index` 只表示逻辑顺序，不能充当宿主段落索引。WPS 仅接受完整物理哈希或经过验证的子范围锚点。表格单元格在没有正式表格识别合同前跳过。一个物理段落包含多个格式角色时，预览标记为“混合结构，需要拆段/复核”，正式排版不得任选其中一个角色覆盖整段。
- 自动验证门槛：以 `005` fixture 验证 46 个正文物理段落、49 个表格段落、79 个 wheel 逻辑块之间的显式映射；“主标题续行”必须锚定第一个物理段落中的对应子范围，不能落到第二个物理段落；5 个非空表格单元格不得产生伪造角色；所有批注必须有完整哈希或子范围锚点证明，禁止裸序号 fallback。

实施状态（2026-07-30）：wheel/SDK 已输出物理段落哈希、物理出现序号和 UTF-16 子范围；WPS 已删除 dense/non-empty/裸序号 fallback。真实 `005` 服务结果为 78/78 个段落块 locator verified、0 个未定位、19 个混合物理段落。保存后批注 OOXML 仍需重新验收，不能仅凭即时界面写为完整 PASS。

## P012 跨文档沿用旧预览 tracker

- 症状：在文档 A 完成预览后切换到文档 B，直接点击“一键排版”返回 `DOCUMENT_CHANGED`，即使文档 B 本身没有被修改。
- 根因：宿主切换文档时只清空任务窗格显示状态，没有清空 composition 中属于文档 A 的内存预览 tracker。
- 禁止：把 `DOCUMENT_CHANGED` 当作识别失败；不得尝试用文档 B 清理文档 A 的批注。
- 正确方案：检测到活动文档身份变化时，仅清空旧 tracker 和显示状态；保留文档 A 已保存的批注，不跨文档调用 `removePreviewComments`。
- 自动验证门槛：切换文档后 tracker 为 null、混合/未定位数量归零；源码/单测证明切换路径不调用批注删除；真实 WPS 在文档 B 再次执行时不再被文档 A 的 tracker 阻断。

## P013 任务窗格获得焦点时 Ctrl+S 未保存 WPS 文档

- 症状：界面已显示预览批注，按 `Ctrl+S` 后看似无错误，但关闭后保存的 DOCX 中没有 `comments.xml`；COM 读回 `Document.Saved=false`。
- 根因：键盘焦点位于任务窗格 WebView，快捷键被网页上下文接收，没有触发 WPS 文档保存。
- 禁止：把发送过 `Ctrl+S`、窗口标题存在或即时批注可见当作已保存证据。
- 正确方案：自动验收固定使用 WPS 文档对象的 `Document.Activate() → Document.Save()`，确认 `Document.Saved=true` 后正常关闭文档，再读取 DOCX/OOXML。
- 自动验证门槛：关闭前 `Saved=true`；关闭后 DOCX 可读；`comments.xml` 中 DocxTool 批注数量、作者角色和子 Range 哈希与 wheel 计划一致；正文 SHA-256、段落数和顺序保持不变。

## P014 PowerShell 连续命令掩盖前序测试失败

- 症状：测试输出中已经出现 pytest 收集错误或失败，但整段验证命令最终仍返回退出码 0，看起来像全部通过。
- 根因：PowerShell 的 `$ErrorActionPreference = "Stop"` 不会自动把外部程序的非零退出码转换为终止错误；后续成功的 `node`、Ruff 或构建命令覆盖了最终 `$LASTEXITCODE`。
- 禁止：把多个外部验证命令连续执行后只检查最后一个退出码；不得仅凭工具调用的最终 `Exit code: 0` 宣称前序测试通过。
- 正确方案：每个外部命令执行后立即检查 `$LASTEXITCODE`，非零时立刻 `throw`；优先使用项目锁定的 `.venv`，避免系统 Python 缺少依赖导致伪代码故障。
- 自动验证门槛：发布记录分别列出 pytest、Node、Ruff、构建和 WPS `verify:all` 的独立成功结果；任何一步失败都不得进入 commit/push。

## P015 WPS 本级虚拟环境与 wheel 安装被其他源码目录绕过

- 症状：用户要求恢复或重装 wheel 后，`pip show docxtool` 在 WPS 本级 `.venv` 中为空，或服务/脚本仍能运行但实际从其他仓库源码目录加载 `docxtool`，导致 wheel 重装不生效。
- 根因：WPS 脚本曾指向旧仓库 `.venv` 或把旧仓库 `src` 放入 `PYTHONPATH`；这会绕过 `D:\PycharmProjects\wps\.venv` 中安装的 wheel。
- 禁止：WPS 插件运行、验证或服务启动时依赖其他仓库 `.venv` 或源码目录；不得用“接口能通”证明 wheel 已恢复。
- 正确方案：WPS 项目固定使用 `D:\PycharmProjects\wps\.venv`；local-agent 与 command-service 只通过本仓库源码路径加载，`docxtool` 只能来自本级 `.venv` 已安装的 wheel；`local-agent` 依赖版本必须与当前 wheel 版本一致。
- 自动验证门槛：`D:\PycharmProjects\wps\.venv\Scripts\python.exe -m pip show docxtool` 显示当前 wheel 版本；Python 直接导入路径位于 `D:\PycharmProjects\wps\.venv\Lib\site-packages\docxtool`；`scripts\verify-all.ps1` PASS。

## 本轮固定批注模板

```text
识别结果：主标题 中文字体：方正小标宋简体 西文字体：Times New Roman 字号：二号 粗体：否
对齐方式：居中 首行缩进：0 字符 左缩进：0 字符 右缩进：0 字符 段前：0 行
段后：0 行 固定行距：28 磅 段前分页：否 识别状态：需要复核 识别置信度：50%
```

每行项目之间只使用一个半角空格，不插入空行。

真实 WPS 中 `Comment.Content` 是批注正文，`Comment.Range.Text` 是被批注的文档文字。不得用 `Range.Text` 校验批注正文，否则会误报 `PREVIEW_COMMENT_READBACK_FAILED` 并清理已创建批注。预览结果为 0 条或带有写入警告时必须返回失败，不得把降级结果写成 PASS。

WPS 可能把 `\n`、`\r` 或宿主换行控制符互相转换；批注读回和所有权比较必须先把连续空白归一为一个空格。

当前 WPS 的 `Comment.Content` 即时读回可能只返回首段或经过截断，而界面实际已经显示完整批注。即时所有权校验使用稳定首字段（如“识别结果：主标题”）；完整字段不得靠即时字符串相等判断，必须在保存后的 `comments.xml` 中检查。

部分 WPS 版本不稳定返回新批注的 `Reference.Start/End`。在执行前已通过 tracker 校验文档身份的前提下，DocxTool 批注清理使用当前 tracker 中的稳定“识别结果”签名；不得因 Range 缺失把已成功写入的批注判为失败。

部分 WPS 版本的 `Comments.Add` 已成功增加批注但返回 `undefined`。调用前后必须比较 `Comments.Count`；返回值为空但数量增加时，从 `Comments.Item(Count)` 取得新批注再读回，不得把空返回值等同于写入失败。

批注展示字段必须先形成有序数组，再按固定索引分组和拼接；不得在多个分支中各自拼整段文案。当前每组使用 `fields.slice(...)`，组内项目使用一个半角空格分隔。

新预览会话开始前必须记录用户批注指纹。WPS 返回值、正文对象和 Range 均不可用时，在已通过文档身份校验的前提下，以“不在用户批注基线中的新增批注”作为当前 DocxTool 会话所有权依据；最终仍必须用 OOXML 证明用户批注数量未变化。

保存后 Range 或日期变化时，清理优先匹配“识别结果”签名；签名读取不到时，用预览前用户批注指纹中的作者集合保护既有用户批注，其余新增批注才归当前预览会话。若用户既有批注作者与插件当前作者相同，必须依赖可读签名，不能只按作者删除。

用户批注完整性指纹只使用稳定的“作者 + 缩写 + 归一化批注正文”；禁止把 WPS 会重算的 Range、Start/End 或日期放入完整性指纹。

当前 WPS 的批注集合即时读回不作为 PASS 门槛。预览调用只记录未抛异常的创建操作；是否真正成功必须由保存后的 `comments.xml` 中 DocxTool 批注存在、完整字段存在以及用户批注数量不变共同判定。

WPS 保存批注会重组批注锚点和运行节点，可能只改变格式修订指纹。预览后的过期识别拒绝必须以正文 SHA-256、段落数、段落顺序、节数和文档身份为准；不得仅因批注导致的格式指纹变化报 `DOCUMENT_CHANGED`。正式执行前仍由事务重新捕获当前格式。

## P016 source、canonical、host 与 WPS Range 坐标混用

- 症状：本地只读 E2E 能生成命令，但包含软换行、重复段落或一个物理段内多个逻辑片段时，命令目标可能按逻辑块序号或 source UTF-16 偏移落到错误 WPS 段落。
- 根因：source locator 只证明 DOCX 原始物理段落内的片段位置；canonical 偏移只用于规范化比较；host snapshot 偏移也不是 WPS API 的绝对 Range 坐标。任何一个坐标系被直接复用都会绕过实际段落和文字读回。
- 禁止：使用 `block_index`、`source_paragraph_index`、裸段落序号、全文首次匹配或 source raw/canonical offset 直接创建 WPS Range；不得让不完整片段组以部分 confirmed 状态进入一键排版。
- 正确方案：先以 `bind_recognition_plan()` 绑定完整 HostSnapshot，再以 `host_paragraph_index + host_raw_start_utf16 + host_raw_end_utf16 + host_raw_text_sha256` 重新读取 WPS 物理段落，验证子 Range 哈希后才创建目标。`review` 仅预览，`unresolved` 和混合片段组全部跳过。跨语言文本规范化必须通过同步的 `HOST_TEXT_V1_GOLDEN.json`。
- 自动验证门槛：`local-agent/tests/test_local_agent.py` 的只读链路测试必须确认命令服务不接收正文，`tests/host-text-golden.test.mjs` 必须匹配 Python 金标，`tests/wps-phase-one.test.mjs` 必须覆盖精确 Range、混合片段跳过、表格跳过和事务回滚，`pwsh -NoProfile -File scripts/verify-all.ps1` 必须通过。

## P017 wheel 升级后仍向绑定入口传旧版简化 HostSnapshot

- 症状：wheel 可导入且识别成功，但 `/v1/handshake` 或 `/v1/recognize` 在绑定前返回 `INVALID_HOST_SNAPSHOT`，错误路径指向 `schema_version`、`host`、`snapshot_id` 或段落故事字段。
- 根因：WPS 对外请求仍是简化段落快照，local-agent 直接把该对象传给新版 `bind_recognition_plan()`；新版 SDK 要求所有 Mapping 先通过正式 JSON Schema，不能再依赖旧对象构造器的隐式补全。
- 禁止：放宽 wheel Schema、绕过 `host_snapshot_from_dict()`，或让 WPS 前端自行拼两套不同版本的绑定对象。
- 正确方案：WPS 请求格式保持稳定，只在 local-agent 的唯一适配边界补齐 `host-snapshot-v1`、协议版本、稳定 snapshot/paragraph ID、story 位置、文档修订、`utf16_code_unit` 和严格 boolean，再交给 wheel 校验和绑定。
- 自动验证门槛：local-agent handshake、识别和只读命令链测试通过；隔离导入显示 wheel 版本正确；`scripts/verify-all.ps1` 全部通过。

## P018 WPS 配置同步脚本依赖上级 docxtool 源码目录

- 症状：WPS 仓库移动为独立目录或只安装 wheel 后，`sync-default-format-profile.py --check` 查找不存在的上级 `src/docxtool/resources/config/default-format.json`，导致总门禁失败。
- 根因：脚本按固定父目录层级定位 DocxTool 源码，绕过了 WPS 本级 `.venv` 中已安装 wheel 的包资源。
- 禁止：恢复绝对路径、`..\src`、上级 `PYTHONPATH` 或复制一份无人维护的默认配置作为新真值。
- 正确方案：通过 `importlib.resources` 从本级已安装 `docxtool.resources` 读取默认配置，并通过包元数据写入实际 wheel 版本；生成的命令配置仍保留在 WPS 仓库内。
- 自动验证门槛：导入路径位于 `wps\.venv\Lib\site-packages\docxtool`；profile `--check` 通过；`scripts/verify-all.ps1` 输出 `VERIFY_ALL_PASS`。

## P019 稳定错误码直接暴露给用户

- 症状：任务窗格“执行状态”“问题与复核”或“功能检测”只显示 `DOCUMENT_MUST_BE_SAVED`、`LOCAL_AGENT_UNAVAILABLE` 等英文错误码，用户无法直接判断下一步怎么处理。
- 根因：HostResultStore 只保存稳定错误码，任务窗格和 Ribbon 兜底脚本直接渲染该字段，没有统一的用户可读中文映射。
- 禁止：在用户界面只显示英文错误码；不得在多个分支中各自硬拼一套不一致的中文说明。
- 正确方案：稳定错误码继续保留用于排查和自动化判断；用户界面统一调用中文错误映射，显示“中文处理说明 + 错误码”。`DOCUMENT_MUST_BE_SAVED` 必须明确提示先在 WPS 中保存为本地 DOCX 文件。
- 自动验证门槛：Node 测试覆盖 `DOCUMENT_MUST_BE_SAVED` 中文说明和错误码保留；功能检测失败报告包含中文原因；`npm test` 与 classified build 通过。

## P020 任务窗格按钮点击后无反应

- 症状：任务窗格已显示，点击“预览排版”“一键排版”后界面仍停留在“就绪”或原状态，本地服务健康，`current.json` 只出现 `main_script_loaded`，没有 `host_router_installed`。
- 根因：WPS WebView 加载主脚本时 `Application` 对象尚未注入；旧代码只安装一次 HostCommandRouter，遇到 `WPS_APPLICATION_UNAVAILABLE` 后不再重试。任务窗格按钮只把请求写入 `PluginStorage`，没有主上下文消费请求。
- 禁止：遇到无反应就修改识别 wheel、命令服务或另写测试执行器；不得把按钮点击无反馈当成识别失败。
- 正确方案：主上下文安装必须等待并重试，直到 `Application` 和 build info 均可用后再安装 HostCommandRouter；任务窗格发送命令后必须显示“命令已发送，等待 WPS 主上下文处理…”，不能被旧状态轮询覆盖成“就绪”；Ribbon fallback 中 `CreateTaskPane()` 返回空值时必须写入 `TASKPANE_CREATE_FAILED`，不得继续访问 `pane.ID` 或静默吞错。
- 自动验证门槛：源码测试断言 `host-runtime.ts` 包含 `tryInstall` 重试安装和 `host_router_installed` 上报；测试覆盖生产 Ribbon 直接调用 `DocxtoolHostDispatch`、不使用 `CustomEvent/dispatchEvent`、任务窗格即时等待状态、`CreateTaskPane()` 空返回写入稳定错误；真实 WPS 状态必须从 `main_script_loaded` 继续到 `host_router_installed` 后，按钮才可判定为可用。

## P021 production 入口不注入 runtime config 且 ribbon 脚本文件名错位

- 症状：WPS Ribbon 的“预览排版”“一键排版”“功能检测”按钮点击后无效；按 dist 发布时 WPS 对每个按钮报“无效命令/回调未找到”；`.runtime/e2e/current.json` 只有 `main_script_loaded`/`host_module_loaded`/`ribbon_onload`，始终没有 `host_router_installed`。
- 根因：两个独立缺口叠加。(a) `main.production.js` 引用 `js/ribbon-production.js`，但 `vite.config.js` 的 production 构建把该文件输出为 `dist/js/ribbon.js`，导致发布 dist 后 ribbon 脚本 404、全局 `OnAction` 未定义，WPS 对每个按钮报无效命令（debug 模式下 3889 直接服务源码目录，`js/ribbon-production.js` 存在，故只影响 production 发布）。(b) `main.production.js` 未加载 `ui/e2e-session.js`，且 `vite.config.js` 未把该文件拷贝进 dist，导致 `window.DocxtoolRuntimeConfig`（recognition/command 端点与 session token）从未注入；`host-runtime.ts` 的 `runtimeConfig()` 因此抛 `PRODUCTION_COMPOSITION_NOT_READY`，`install()` 失败，HostCommandRouter 永不安装，所有按钮命令无人消费。
- 禁止：在按钮回调中吞掉 `DocxtoolHostDispatch` 缺失；不得把 Ribbon 回调改回浏览器 `CustomEvent/dispatchEvent`；不得在 host-runtime 或 composition 中硬编码端点/token 默认值；不得把 `ui/e2e-session.js` 从生产入口删除（它由 prepare 生成、含 9528 统一入口与 session token，属 `.gitignore`）。
- 正确方案：production 入口与构建输出文件名必须一致（统一引用 `js/ribbon.js`，构建时其内容为 production ribbon）；production 入口必须按“build-info → default-format-profile → e2e-session → ribbon → host-runtime”顺序加载 `ui/e2e-session.js`；`vite.config.js` 的 copyFile 必须把 `ui/e2e-session.js` 拷贝进 dist；`verify-addin` 必须把 `ui/build-info.js`、`ui/e2e-session.js`、`ui/default-format-profile.js` 列为 classified 生产产物。
- 自动验证门槛：Node 测试断言 `main.production.js` 引用 `js/ribbon.js`（不含 `js/ribbon-production.js`）且加载 `ui/e2e-session.js`、`vite.config.js` 拷贝 e2e-session.js；`npm run build:classified` 后 `dist/js/ribbon.js` 存在且为 production ribbon、`dist/ui/e2e-session.js` 存在；`npm run verify:addin -- classified-offline` PASS；真实 WPS 重启后 `current.json` 出现 `host_router_installed` 且按钮可点击。当前 WPS 进程早于最新 build 启动时，必须关闭全部 WPS 窗口重新打开，不能只靠服务重启。

## P022 WPS 宿主异常被吞掉，无法落盘定位

- 症状：点击“预览排版”后没有界面变化，Console、PluginStorage 或 E2E 状态只留下最后一个稳定错误码，无法判断中断在 main、Ribbon、Host 安装、HTTP 请求还是 WPS 批注写入。
- 根因：WPS WebView 的早期脚本、Ribbon Promise、Host 安装重试和任务窗格轮询分属不同上下文；旧实现存在空 `catch`，原始异常及 stack 没有统一关联 ID，也没有安全写入仓库根目录的通道。
- 禁止：不得让 WebView 直接调用文件系统；不得把正文、完整路径、session token、Authorization、Cookie、请求体或响应体写入日志；不得因为加日志而改变识别、格式协议或正式执行顺序；日志失败不得阻断业务。
- 正确方案：main 使用最多 500 条的内存早期队列；Host/任务窗格安装固定 loopback logger，经带 session header 的 `POST /v1/diagnostics/logs` 发送；local-agent 作为唯一运行时文件写入者，执行二次脱敏并以 UTF-8 JSONL 写入 `wps-plugin-debug.log`，按 5 MB × 5 轮转。Ribbon、Host router、识别/命令请求和 WPS 批注阶段沿用同一 correlation/request/command ID；公开 HostState 只保留稳定错误码，原始异常仅进入脱敏根日志。
- 自动验证门槛：Node 测试覆盖队列 500、批次 50、失败回队首、ERROR 立即 flush、早期队列接管、脱敏和 dispose；Python 测试覆盖鉴权、事件/批次大小、二次脱敏、UTF-8、轮转和并发完整行；classified dist 必须包含 `bootstrap.main.loaded`、`ribbon.action.received`、`host.install.success`、`host.router.dispatch.received`；`verify-all.ps1` PASS。真实 WPS 只能在新 build 重启后、根日志出现完整宿主链并完成批注读回时写 PASS。

## P023 Vite ES module 产物被 classic script 加载

- 症状：E2E 已出现 `main_script_loaded`、`ribbon_onload`，静态资源请求也返回 200，但没有 `host_module_loaded`；任务窗格工作流同样不执行，按钮可能显示但没有正式桥接。
- 根因：Vite 的多入口产物 `host-runtime.js`、`taskpane-workflow.js` 会静态 `import` 共享 chunk；main 和 taskpane HTML 却用没有 `type="module"` 的 classic script 标签加载。浏览器在模块正文第一行之前即因 `import` 语法失败，因此任何模块内日志都来不及执行。
- 禁止：不得通过删除共享依赖、复制业务实现或把 bundle 文本拼接成假单文件规避；不得把 Ribbon 回调本身改为 module 后失去 WPS 所需的全局函数。
- 正确方案：build-info、runtime config 和 Ribbon 继续使用 classic script；仅对 Vite ESM 产物 `host-runtime.js`、`taskpane-workflow.js` 使用 `type="module"`。Host 自带安装重试，允许 module 延后执行后再等待 `Application`、build 和 runtime config。
- 自动验证门槛：源码测试断言开发/生产 main 的 host runtime 使用 module 标签，两个 taskpane workflow 通过 module 动态导入；classified build 后产物首部可含静态 `import`，但所有加载点必须采用 module 语义；`verify-addin` 强制检查 production main 和 build 版本参数；真实 WPS 重启后根日志必须出现 `host.module.loaded` 和 `host.install.success`。

## P024 Ribbon 直接驱动业务与本地直连 runtime 未收口

- 症状：Ribbon 点击后需要等 HostDispatch/任务窗格/旧 9528 链路，或者 TaskPane 自动弹出抢占焦点；健康检查仍围着识别服务、命令服务和 session token 打转。
- 根因：入口层、Host 路由、TaskPane 和 E2E 预览状态仍混在一起；生产入口继续依赖 `ui/e2e-session.js`、HTTP 端点和旧 `DocxtoolHostDispatch`，导致界面与业务耦合。
- 禁止：Ribbon 直接调长任务；任务窗格自动开/关业务面板；生产代码重新引入 9528、HttpCommandServiceClient、HttpLocalRecognitionTransport、LocalEndpointProvider 或 session token；把没有 exe 的本地直连伪装成可用。
- 正确方案：Ribbon 只调用 `DocxtoolHostEnqueue`；Host 统一串行队列消费命令；TaskPane 只展示状态并可返回文档；健康检查只看本机 FileSystem、ShellExecute、runtime current.json 和 exe 存在性；本地 runtime 缺失时必须明确报 `LOCAL_RECOGNITION_RUNTIME_BUILD_NOT_CONFIGURED` / `LOCAL_RECOGNITION_RUNTIME_NOT_FOUND`，不能偷偷回退 HTTP。
- 自动验证门槛：`npm run typecheck`、`npm test`、`npm run verify:local-direct`、`npm run build:classified`、`npm run verify:addin -- classified-offline` 全部通过；生产扫描不得命中 `HttpLocalRecognitionTransport`、`HttpCommandServiceClient`、`LocalEndpointProvider`、`recognitionEndpoint`、`commandEndpoint`、`sessionToken`、`127.0.0.1:9528`、`/v1/recognize`、`/v1/commands` 或 `DocxtoolHostDispatch`；真实 WPS 中按钮点击后应先显示入队状态，再由同一队列异步完成。

## P025 WPS 仓库路径误判为旧嵌套目录

- 症状：代码或文档被写入迁移前旧嵌套目录或其上级项目，而不是当前 WPS 仓库。
- 根因：历史交接文档保留旧嵌套仓库路径，自动工具的当前工作目录也可能仍指向旧路径。
- 禁止：凭默认工作目录直接修改文件；不得在未核对 `git rev-parse --show-toplevel` 的情况下新增入口、脚本或发布文件。
- 正确方案：每轮涉及本项目文件前先确认当前目录就是 WPS 仓库根；所有相对路径均以该目录为根。只有用户明确要求时才跨目录，且跨目录前必须说明目标和原因。
- 自动验证门槛：`git rev-parse --show-toplevel` 返回当前 WPS 仓库根；本轮 `git status` 只检查该仓库；规范扫描不得把迁移前旧嵌套目录写作事实源。

## P026 本地直连 runtime 构建只做存在性检查

- 症状：`build-local-recognition-runtime.ps1` 只检查 `dist/local-runtime/win-x64/docxtool-recognize.exe` 是否存在，无法在干净工作区生成 runtime。
- 根因：runtime 构建脚本只保留了占位门禁，没有本地识别入口、没有 PyInstaller 打包、也没有 manifest。
- 禁止：继续回退到 9528；把“检查 exe 存在”伪装成“已经构建 runtime”；在没有 manifest 和 current.json 的情况下宣称本地直连可用。
- 正确方案：runtime 入口统一使用 `local-runtime/recognize_entry.py`；构建脚本必须生成 `docxtool-recognize.exe` 与 `runtime-manifest.json`；安装脚本必须写入 `%APPDATA%\Docxtool\runtime\current.json`；验证脚本必须同时检查 dist、安装指针和 9528 关闭状态。
- 自动验证门槛：`scripts/build-local-recognition-runtime.ps1`、`scripts/install-local-runtime.ps1`、`scripts/verify-local-direct.ps1`、`scripts/local-direct.ps1 status` 全部 PASS；`docxtool-recognize.exe --help` 可运行；`current.json` 含 `runtime_version`、`executable_path`、`executable_sha256`、`recognition_package_version`。

## P027 WPS 本地进程调用必须走官方 FileSystem / ShellExecute

- 症状：本地识别临时目录创建、请求写入、结果读取或清理失败，或者 `ShellExecute` 传了多余参数。
- 根因：旧适配器把 `CreateFolder`、`DeleteFile`、`DeleteFolder`、五参数 `ShellExecute` 当成主路径，和 WPS 官方合同不一致。
- 禁止：继续把非官方别名当作唯一实现；不得用 fetch/HTTP 替代本地进程；不得在 production 里重新引入 localhost 识别服务。
- 正确方案：新增 `WpsLocalFileSystem`，主路径使用 `Exists` / `mkdirSync` / `Mkdir` / `writeFileString` / `readFileString` / `unlinkSync` / `rmdirSync` / `Remove`；`LocalProcessRecognitionTransport` 只调用 `ShellExecute(exe, args)` 两参数。
- 自动验证门槛：Node 测试覆盖官方方法、fallback 和稳定错误；`tests/wps-phase-one.test.mjs` 覆盖 `quoteWindowsCommandLineArgument` 与 `LocalProcessRecognitionTransport`；生产扫描不得再命中 `HttpLocalRecognitionTransport`、`HttpCommandServiceClient`、`LocalEndpointProvider`、`sessionToken`、`127.0.0.1:9528`、`/v1/recognize`、`/v1/commands` 或 `DocxtoolHostDispatch`。

## P028 常驻开发服务不得被入口同步等待

- 症状：`main.py start` 停在“注册 WPS 插件项目”，最终超时或一直没有后续中文日志。
- 根因：`wpsjs debug -s` 会持续提供加载项资源，不会自行退出；将其交给同步命令执行器会阻断整个启动链。
- 禁止：用加大超时时间掩盖常驻进程；把“进程没有退出”报告成构建失败；重复启动同一端口服务。
- 正确方案：入口后台启动该进程，以 3889 端口可连接作为就绪条件；端口已经就绪时直接复用。一次性构建和验证命令仍同步执行并检查退出码。
- 自动验证门槛：从无监听状态执行 `main.py start` 必须在合理时间内返回 0，并依次输出“注册项目已加载”“WPS 功能检测已完成”“启动完成”；再次执行时不得因端口占用失败。

## P029 PyCharm 解释器名称正确但全局 SDK 路径失效

- 症状：运行配置和模块都显示 `Python 3.8 (wps)`，实际运行仍提示“找不到此运行配置的 Python 解释器”。
- 根因：项目文件只保存 SDK 名称，PyCharm 全局 `jdk.table.xml` 中同名 SDK 的 `homePath`、环境根或关联项目仍指向迁移前目录。
- 正确方案：同时核对全局 SDK 登记、`.idea/misc.xml` 的项目 SDK、模块 `jdkName` 和运行配置；运行配置优先使用模块 SDK，避免再保存独立路径。
- 自动验证门槛：全局同名 SDK 只对应当前项目虚拟环境；解释器文件可执行；项目配置中没有迁移前路径；固定 `main` 配置的 `IS_MODULE_SDK=true`；`main.py status` 返回 0。

## P030 重建虚拟环境后本地 runtime 构建失败

- 症状：`main.py start` 在“构建本地识别组件”失败，底层报告 PyInstaller 构建失败或未安装。
- 根因：重建 `.venv` 后只有基础打包工具，没有安装项目根目录的 `docxtool 4.0` wheel、其运行依赖和 PyInstaller。
- 正确方案：使用当前 `.venv` 从项目根目录本地 wheel 安装 `docxtool 4.0`，再安装兼容 Python 3.8 的 `PyInstaller<7`；开发验证环境同步安装项目锁定版本的 pytest 与 ruff。
- 自动验证门槛：可导入 `docxtool` 和 `PyInstaller`；runtime 构建脚本返回 PASS；生成的 exe 可执行 `--help`；runtime 单元测试通过；最后完整执行 `main.py start`。

## P031 Ribbon 可见但点击无反应且没有新日志

- 症状：3889 和 WPS 注册均正常，Ribbon 已显示，但点击没有反馈，根目录旧日志也没有当前事件。
- 根因：WPS 内嵌浏览器可能没有 `crypto.randomUUID()`；Host 安装阶段直接调用会中断，Ribbon 只剩外壳。旧本地直连日志仅存在内存队列，无法从宿主外部查看。
- 正确方案：正式宿主链所有随机 ID 必须检测 `crypto.randomUUID` 并使用 `crypto.getRandomValues` 兼容；诊断事件通过 WPS FileSystem 写入仓库根目录 `wps-plugin-debug.log`，不恢复 9528。`main.py start` 默认常驻展示中文日志。
- 自动验证门槛：旧浏览器环境不得因缺少 `randomUUID` 阻止 Host 安装；构建、类型检查和 Ribbon/Host 测试通过；真实 WPS 重新加载后日志必须出现 `application.install.success`，点击后必须出现 `ribbon.action.received` 和 `application.runtime.run.received` 或明确的中文错误。

## P032 开发注册加载源码但验证的是 dist

- 症状：构建和 verify-addin 均通过，真实 WPS 却执行另一套 main、Ribbon 或 Host 路径。
- 根因：wpsjs debug 从源码目录服务，而 Vite 根据环境变量复制 production 副本；源码 main 又引用 dist 子目录，形成双重入口。
- 禁止：保留两套业务入口；debug 服务源码而只验证 dist；源码 main 引用 `dist/host-runtime.js`。
- 正确方案：canonical `main.js`、`js/ribbon.js` 是唯一入口和复制源，source/dist 构建后必须一致；后续 debug 只服务由 dist 生成的唯一 package。
- 自动门槛：main/ribbon source 与 dist 分别字节一致；不存在 production 业务副本；main 不含 `dist/host-runtime.js`。

## P033 WPS 早期启动失败没有独立日志

- 症状：Ribbon 无响应，Host 文件日志为空，无法判断 main、Ribbon 或 Host 哪层未执行。
- 根因：早期日志依赖 Host Runtime 安装成功后才建立，Host 自身装载失败时没有落盘渠道。
- 禁止：只保留内存队列；依赖识别 runtime、Host Router、HTTP 或 9528 才能记录 bootstrap 错误。
- 正确方案：最先加载经典 `bootstrap-probe.js`，独立捕获 error/rejection，并通过 3889 的诊断专用端点写入仓库根 `wps-plugin-debug.log`。早期日志不得依赖尚未验证的 WPS FileSystem 写入能力。
- 自动门槛：main 首个业务脚本为 probe；probe 包含 `bootstrap.probe.loaded`、`window.error`、`window.unhandledrejection` 和 `/__docxtool_log`，且不存在 250ms 文件日志轮询；真实 WPS 当前 build 的早期事件必须落入根目录日志。
- 当前补充：3889 只承载插件静态资源与诊断事件，不承载识别或排版业务，也不依赖 9528。

## P034 WPS 本地应用 Runtime 使用 ES Module 静默失败

- 症状：Ribbon 外壳出现，但 Runtime 装载事件和 `DocxtoolRunLocalCommand` 不存在。
- 根因：Host 产物使用 module 标签、静态 import 和共享 chunk，当前 WPS WebView 可能不执行或无法解析。
- 禁止：Host Runtime 使用 `type=module`、静态/dynamic import 或依赖外部 chunk。
- 正确方案：本地应用 Runtime 单独构建为经典 IIFE 单文件，main 用普通 script 顺序加载。
- 自动门槛：产物无 import，包含 Runtime 装载事件和 `DocxtoolRunLocalCommand`；Ribbon 三个回调显式挂到 window。

## P035 WPS 本地功能仍经过 Host 队列中转

- 症状：虽然识别 EXE 和命令生成器都在本地，Ribbon 仍执行 `HostEnqueue → LocalCommandBus → HostCommandRouter`，让本地直调看起来像另一套服务链。
- 根因：早期为了异步调度和 TaskPane 共用而增加了 Host 队列层，后来正式 Application Use Case 已稳定，但入口没有同步收口。
- 禁止：生产 Ribbon 使用 HostEnqueue/HostDispatch；为预览或排版另写队列执行器；回退 HTTP、9528、local-agent 或 command-service。
- 正确方案：唯一全局入口为 `DocxtoolRunLocalCommand`，直接进入 `LocalApplicationRuntime` 和正式用例；用一个执行中互斥锁阻止重复点击。TaskPane 也调用同一入口。
- 自动门槛：生产入口扫描不得出现 `DocxtoolHostEnqueue`、`DocxtoolHostDispatch`、`HostCommandRouter` 或 `LocalCommandBus`；Ribbon 测试证明四个按钮直接调用同一 Runtime；verify-local-direct 必须 PASS。

## P036 wpsjs 静态服务弹出 CMD 并额外启动 WPS

- 症状：运行 main 后出现独立 CMD/Terminal 窗口，`wpsjs debug -s` 还可能拉起新的 WPS 窗口。
- 根因：官方调试工具同时承担资源服务、注册和宿主启动，长期运行不适合作为已经注册后的常驻资源进程。
- 禁止：每次启动重复执行 wpsjs debug；用屏幕脚本关闭窗口；结束未知 Node 或 WPS 进程。
- 正确方案：先用 XML 检查现有 WPS 注册；注册匹配时以 `CREATE_NO_WINDOW` 启动隐藏静态资源进程，只服务唯一 debug-package。记录 PID、端口、目录和 Build ID，并通过 HTTP 哈希探针验证归属。
- 自动门槛：完整启动后新增 WPS 进程数为 0；3889 owner 为记录的隐藏静态进程；控制台显示资源和交互日志；重复启动可复用且不因目录锁失败。

## P037 WPS 已显示 Ribbon 但仍执行旧页面

- 症状：WPS 功能区仍可见，启动器和 3889 服务均 PASS，但按钮没有日志或动作；资源服务实际上没有收到当前构建的加载事件。
- 根因：WPS 的 `publish.xml` 注册和内嵌 WebView 缓存不会被普通资源服务重启自动刷新；官方 `wpsjs debug` 文档与本地源码均要求运行中的 WPS 重启或刷新加载项后重新读取注册和页面。仅替换服务器或清空 Python 访问日志不能替代宿主重载。
- 禁止：看到 Ribbon 可见就判定当前源码已经加载；不得在按钮无反应时先修改识别、排版或 WPS API 业务逻辑；不得强制结束存在用户可见文档的全部 WPS 进程。
- 正确方案：资源服务使用同端口诊断回传和 `Cache-Control: no-store`；`main.py diagnose` 只统计当前 build_id 的事件。先完成保存并正常关闭脱敏测试文档，再完整关闭残留 WPS 宿主并重新打开，确认 `bootstrap.probe.loaded`、`ribbon.addin.load.success`、`application.install.success` 后再验收按钮。
- 自动验证门槛：服务端接收 `POST /__docxtool_log` 并写入根目录 `wps-plugin-debug.log`；HTTP 资源探针 PASS；旧 build 事件不污染诊断；真实 WPS 重载后出现当前 build 的加载事件，按钮点击出现 `ribbon.action.received`。

## P038 WPS FileSystem 拒绝 runtime 清单路径

- 症状：Ribbon 和 Host 脚本均已加载，日志反复出现“读取本地运行时配置失败；错误：`path cannot contains '/' or '\\'`”，随后持续“等待 WPS Application、构建信息和本地运行时配置”；三个正式按钮没有进入本地 Runtime。
- 根因：`runtimeConfig()` 使用非官方兼容方法 `ReadFileString` 读取绝对路径。当前真实 WPS 的该兼容方法把参数按“文件名”处理并拒绝 `/`、`\\`，而官方 `wps-jsapi 1.0.5` 声明的读取入口是 `Application.FileSystem.ReadFile(path)`。单纯替换路径分隔符无法解决。
- 禁止：只在字符串上盲目把 `\\` 换成 `/` 或反过来；只修清单读取而不检查识别 exe、请求文件、结果文件和日志文件的同一套路径语义；继续每 250ms 无限刷 WARN。
- 正确方案：唯一 WPS 文件适配层优先调用官方 `ReadFile`，仅在旧宿主没有官方方法时回退 `readFileString/ReadFileString`；`Exists`、路径规范化、runtime 清单、health check 和识别 transport 共用该适配层。官方单参数 `AppendFile(path)` 不得误传正文内容。早期和宿主诊断日志统一走 3889 诊断端点，避免用未确认的 WPS 文件写入方法制造二次故障。
- 自动验证门槛：适配器单测证明官方 `ReadFile` 优先于兼容方法，单参数 `AppendFile` 不会被当作两参数写入；控制台自动识别 UTF-8/GB18030 并折叠连续相同事件。真实 WPS 重载后当前 build 必须出现一次 `application.install.success`、零次 `application.install.config.failed`，安装成功后不得继续产生安装轮询。
- 真实验证结果：build `20260805144325-b0b446021681` 已在 WPS 12.1.0.28043 中加载；记录 1 次 `application.install.attempt`、1 次 `application.install.success`、0 次 `application.install.config.failed`，随后轮询停止。

## P039 保存于 DOCX 的旧预览批注与当前 wheel 输出不一致

- 症状：打开已有“识别预览工作副本”后，标题与正文粘在同一物理段落时仍显示整段“主标题续行”或其他旧角色，看起来像当前 wheel 分类错误。
- 根因：预览批注会随 DOCX 保存。旧版本曾按整段写入批注；升级 wheel、SDK 或 WPS 适配器不会自动改写文件中已保存的旧批注。只看批注侧栏无法证明当前识别结果。
- 正确判断：先读取当前 wheel 的 `physical_paragraph_index`、`raw_start_utf16/raw_end_utf16`、`segment_count_total` 和定位状态，再与 DOCX `commentRangeStart/commentRangeEnd` 对比。当前 wheel 若已返回不重叠且完整覆盖的“标题子范围 + 正文子范围”，而 DOCX 仍只有覆盖整段的旧批注，则属于旧预览未清理或当前预览尚未重新执行，不是 WPS 丢失了已发送的子范围信号。
- 处理规则：重新预览前必须删除本插件旧批注并重新识别；同一物理段多个角色只允许按精确子 Range 预览，正式排版继续标记“需要拆段”，不得把多个段落级样式直接应用到同一物理段。
- 验证门槛：脱敏样本中同段一级标题和正文必须分别产生两个已验证范围，范围连续、不重叠、覆盖全部可见文字；WPS 新批注锚点必须分别等于两个范围，旧整段批注数量为 0。

## P040 PreviewDocumentUseCase 在 WPS 主线程执行完整快照导致卡死

- 症状：点击预览后日志停在 PreviewDocumentUseCase 开始阶段，尚未出现本地识别进程启动事件，WPS 界面失去响应。
- 根因：生产预览在 WPS 页面线程同步遍历全部段落读取文本和表格状态，随后又逐段读取字体、段落格式及分节信息生成 formatting revision；识别 EXE 尚未启动，主线程已连续执行两轮全文宿主访问。
- 禁止：仅在全文循环中增加 `setTimeout(0)` 并宣称完成线程解耦；把 WPS 宿主对象传给 Worker；在能力探针失败时回退同步大循环。
- 正确方案：classic Worker 负责流程和分批调度，WpsHostBridge 每次最多读取 10 段并立即返回纯数据；哈希、快照组合和后续识别协调在 Worker 完成。
- 自动验证门槛：生产 Ribbon 不再直接调用完整 `readSnapshot()`；Host 单批不读取 Font/ParagraphFormat、不递归下一批；0/20/200/1000 段快照语义等价，真实 WPS 可在读取期间滚动和操作。

## P041 activeRevision 在格式批次之间反复扫描全文

- 症状：正式排版命令越多，WPS 越慢，批次让出事件循环后仍可能长时间未响应。
- 根因：执行开始和每个 `yieldEvery` 批次都会重新遍历全文计算 active revision，复杂度接近“段落数 × 命令批次数”。
- 禁止：保留批次间全文 `activeRevision()`；用更大的批次掩盖重复扫描；取消完整事务回滚。
- 正确方案：Worker 快照 revision 负责文本基线，Host 在每个待写目标前只校验文档 token、段落文本和目标 Range hash；事务只捕获实际修改目标并分批回滚。
- 自动验证门槛：生产执行路径无批次间全文扫描；每批格式命令最多 3 条；目标变化拒绝、写入读回、失败回滚和迟到结果均有测试。

## P042 流程状态机与 WPS Host API 未分离

- 症状：Host Runtime 的一个长 Promise 同时负责快照、识别等待、命令生成、批注和排版，Ribbon busy 生命周期与长调用栈绑定，无法可靠取消。
- 根因：业务流程状态机、纯计算和不可替代的 WPS JSAPI 位于同一页面线程装配中。
- 禁止：Worker 访问 `window/Application`；TaskPane 冒充 Worker；恢复任何业务 HTTP 服务；未真实验收就写 PASS。
- 正确方案：Worker-Orchestrated WPS Host Bridge。消息只允许经运行时校验的纯 JSON；所有 RPC 带 job/rpc/build/document 标识；Host 只执行有限批次，Worker 控制进度、超时、取消和迟到结果。
- 自动验证门槛：classic Worker 真实宿主探针 PASS；Worker 产物无 WPS API；Host RPC 有硬批次上限；生产 Host 不再直接调用 PreviewDocumentUseCase/FormatDocumentUseCase；取消和事务分批回滚通过真实 WPS 验收。

## P043 Worker 快照只通过 Mock 不能代表真实 WPS 响应性

- 症状：0/20/200/1000 段单元测试全部通过，但真实 WPS 的 Host RPC 可能出现明显长尾，单凭 Mock 耗时会误判线程解耦效果。
- 根因：Mock 不包含 WPS COM/JSAPI 跨边界成本、内嵌浏览器调度和文档宿主负载；自适应批次在真实宿主中可能快速降到 1。
- 禁止：用 Worker 单元测试或构建扫描代替真实 WPS；只记录平均耗时；在 WPS 未完成当前 build 的 `worker.snapshot.shadow.complete` 时写 PASS。
- 正确方案：每个模块使用脱敏 20/200/1000 段 DOCX，分别完整重载当前 build，记录批次数、最小/最大批次、Host RPC 最大值和 P95、Worker 总耗时、主线程最大漂移，并确认 WPS 进程仍为响应状态。
- 验证命令：先运行 `npm test`、`npm run verify:addin -- classified-offline` 和 `npm run verify:local-direct`；再用 `scripts/generate-thread-shadow-fixtures.py` 生成样本并从根目录 `wps-plugin-debug.log` 读取当前 build 的脱敏完成事件。

## P044 PyInstaller 产物遗漏 docxtool SDK 资源

- 症状：虚拟环境直接调用 recognize_docx() 和 recognize_entry.py 均成功，打包后的 docxtool-recognize.exe 却返回 RECOGNITION_FAILED / RecognitionSdkError。
- 根因：PyInstaller 自动收集了 Python 模块和 dist-info，但没有收集 docxtool/resources/config/default-format.json 与 SDK JSON Schemas；识别在加载默认配置时失败。
- 禁止：只验证 EXE 的 --help；看到 RecognitionSdkError 就修改 wheel 分类规则；把源码执行成功当成打包产物成功。
- 正确方案：runtime 构建必须显式使用 --collect-data "docxtool"，并使用真实脱敏 DOCX 请求验证生成的 EXE。
- 自动验证门槛：构建脚本静态测试锁定资源收集参数；EXE 对同一请求退出码为 0，生成识别计划和 binding，不生成 error 文件；安装清单 SHA-256 与当前 EXE 一致。

## P045 WPS ShellExecute 不是可用的微型异步启动 RPC

- 症状：真实 WPS 日志出现 recognition.shell_execute.call.start，数十秒后才出现 returned；期间没有识别进程，也没有 result.json/error.json，Worker 先报 HOST_RPC_TIMEOUT。
- 根因：官方 wps-jsapi 1.0.5 仅声明 OAAssist.ShellExecute(file, params): void，没有异步完成合同；当前 WPS 12.1.0.28043 对本地 EXE 的真实调用同步阻塞约 37.5 秒且未启动进程，不能作为 Host micro-RPC。
- 禁止：增大 Worker timeout 掩盖主线程阻塞；在完整预览或排版中重复试错；改用非官方参数猜测；失败时回退同步 PreviewDocumentUseCase。
- 正确方案：正式线程预览保持默认关闭，稳定返回 THREADED_PREVIEW_RECOGNITION_LAUNCH_BLOCKED；保留调用前、返回和失败三类脱敏事件。只有找到官方支持且真实 WPS 能立即返回并实际启动进程的机制后，才能重新开启。
- 自动验证门槛：脱敏文档中调用前后事件成对出现；Host 调用应在微型 RPC 时限内返回；进程或最终 result/error 文件至少出现一个；Worker 不得先超时。任一条件失败都保持 BLOCKED。

## P046 开发影子快照误在普通打开文档自动运行

- 症状：用户只是打开 WPS 文档，日志却自动出现 worker.snapshot.shadow.start 和全文段落读取。
- 根因：T7 的临时真实宿主验收逻辑在 localhost 且没有开发标记时自动启动 shadow job，验收开关被遗留在常规加载路径。
- 禁止：把开发 shadow、识别探针或 E2E 自动运行绑定到普通加载；在未确认脱敏 fixture 前读取当前活动文档。
- 正确方案：启动时只做 classic Worker 能力探针；snapshot shadow 和 recognition launch probe 只能由显式、localhost 限定的开发标记或专用开发入口启动。
- 自动验证门槛：源码测试确认自动验收函数不含 startSnapshotJob；普通 WPS 加载只有 Worker capability probe，不出现 snapshot/recognition job；显式开发探针继续复用正式 Worker 与 Host Bridge。

## P047 PowerShell 自动变量被当作普通变量

- 症状：诊断命令使用 $Error 保存错误文件路径，PowerShell 报“Cannot overwrite variable Error”，并可能在仓库根生成同名临时文件。
- 根因：$Error 是 PowerShell 只读自动变量，变量名大小写不敏感。
- 禁止：在脚本或一次性验证命令中把 $Error、$Host、$PID、$HOME 等自动变量当作自定义变量。
- 正确方案：使用语义明确的 $errorPath、$resultPath、$processId；命令结束后检查 git status --short，自建临时产物移入 local_recycle/。
- 自动验证门槛：PowerShell 脚本静态检查不对常见只读自动变量赋值；验证命令退出后仓库根无异常同名文件，git status --short 只含预期源码改动。

## P048 自动测试重写受 Git 管理的 DOCX fixture

- 症状：全量测试全部通过，但 git status 显示多个 tests/fixtures/*.docx 被修改，二进制差异无法审阅。
- 根因：只读 OOXML 检查测试在断言前无条件运行全量 fixture 生成器；生成器重写了与该断言无关的 4 个受管理基线，并写入变化的 ZIP 元数据和批注时间。
- 禁止：测试为了读取一个既有 fixture 而重生成整个 fixtures 目录；把测试产生的二进制差异混入功能提交。
- 正确方案：只读检查直接使用受管理的固定 fixture；确需生成时写入 pytest tmp_path，并只生成当前测试需要的文件。
- 自动验证门槛：运行对应 pytest 前后，受 Git 管理的 DOCX blob 哈希不变；git status --short 不新增 tests/fixtures 二进制改动。

## P050 WPS Host 直接 ShellExecute 阻塞识别启动

- 症状：Worker 已完成快照，但 Host 调用 `OAAssist.ShellExecute(exe, params)` 同步阻塞，识别进程没有启动，Worker 先收到 `HOST_RPC_TIMEOUT`。
- 根因：当前 WPS 版本没有为该 JSAPI 调用提供可用的异步完成合同；真实双参数调用会在宿主线程内等待且不产生可靠的 result/error。
- 禁止：继续猜测 ShellExecute 参数、增加 timeout、把 WPS `Application` 传给外部进程、恢复 9528/local-agent/command-service，或回退同步全文预览。
- 正确方案：`main.py` 管理无端口 `docxtool-job-broker.exe`；Host 只写 UUID v4 文件任务，Broker 从受校验的 `current.json` 取得 recognizer 路径与 SHA-256，原子 claim 后使用参数数组和 `shell=False` 启动 EXE。Broker 不读 DOCX 正文、不处理格式命令、不开放网络端口。
- 自动验证门槛：Broker queued 合同拒绝额外 executable/command 字段；claim 使用原子替换；Host 单测确认不访问 ShellExecute 且快速返回；双 EXE SHA-256、安装清单、独立 Broker → recognizer → result smoke 全部通过；真实 WPS 20/200/1000 识别和正式预览未通过前，`threadedPreviewEnabled` 必须为 `false`。

## P051 Local Job Broker 进程生命周期与安装锁

- 症状：PyInstaller one-file Broker 会由启动器产生实际工作 PID；构建重装时旧 EXE 可能占用安装文件，若只记录 `Popen` 父 PID，`main.py stop` 不能准确停止实际 Broker。
- 根因：Windows one-file 启动器 PID 与状态文件中的实际运行 PID 可能不同；未经归属校验的进程结束会扩大影响范围。
- 禁止：结束所有同名 Python/EXE、用未知 PID 重启、复制覆盖被运行 Broker 锁定的 EXE、把 stale 状态直接当成可杀进程。
- 正确方案：`main.py` 只接受 `current.json` 中的 Broker 路径与 hash；优先以 WMI 精确匹配 executable path 停止，PyInstaller one-file 暴露空路径时再同时要求受信 `status.json` 的 path hash、PID 创建时间和同一启动树父/子关系；安装脚本使用同一范围。PowerShell 时间解析必须明确按 UTC 处理。
- 自动验证门槛：Broker `--help`、`--once`、PyInstaller 构建、安装后 hash、healthy reuse、stale restart、运行中重装和未知 PID 不结束均有自动门槛；任务完成不删除用户文档或未知进程，不得使用 `$PID` 作为自定义变量。

## P049 WPS 原生启动探针误带 Params 参数

- 症状：单独验证本地 EXE 时仍复现 WPS `ShellExecute` 同步阻塞，或无法证明宿主实际尝试了最小调用。
- 根因：把正式识别调用的 `--request/--result/--error` 参数复用于启动边界探针；当前 WPS 对双参数形式可能同步等待或不启动进程。
- 禁止：在单参数探针中传空字符串、`undefined`、参数数组或任何命令行；不要把探针直接接入正式识别或打开生产线程预览。
- 正确方案：探针只调用 `OAAssist.ShellExecute(probeExecutablePath)`，由独立 EXE 原子写入 `%APPDATA%\Docxtool\launch-probe\process-started.json` 后退出；仅 localhost debug RPC 可触发，真实通过前保持 `threadedPreviewEnabled=false`。
- 自动验证门槛：Node 测试断言 `ShellExecute` 参数数组长度为 1；Python 探针测试和 PyInstaller EXE 启动均生成 `schema_version=1`、`argv_count=1` 标记；真实 WPS 记录 Host 返回耗时和 5 秒内标记文件是否出现。

## P052 Broker 身份不能只依赖 PID 和 heartbeat

- 症状：旧 Broker 可能继续写出新鲜 heartbeat，或 PID 被系统复用；只读 `status.json` 的 READY、PID 和 heartbeat 会把错误进程当成当前 Broker。
- 根因：PID 与时间上的进程身份不是稳定身份，runtime/Broker 文件替换后还可能留下旧 status。
- 禁止：只要 status 存在就复用；只要 PID 存活就停止或启动；只用 heartbeat 判断 Broker 健康。
- 正确方案：同时校验 `broker_instance_id`、PID 对应进程创建时间、精确 EXE 路径、Broker EXE SHA-256、runtime 版本/SHA-256、Broker 版本、queue contract 和未过期 heartbeat；不匹配时返回稳定身份/版本/hash/contract 错误，不误杀未知进程。
- 自动验证门槛：status identity 字段、旧版本 status、路径/hash/版本/contract 不匹配、PyInstaller 父子 PID、healthy reuse 和 stale restart 均有测试或本地门禁；`npm run verify:local-direct` 必须通过。

## P053 文件队列 claim 必须 exactly-once，并具备租约恢复

- 症状：只用 `os.replace(queued.json, claimed.json)` 无法表达两个 Broker 的独占领取；Broker 在 claim 后崩溃可能让任务永久卡住或重复启动。
- 根因：rename 不是跨实例的 claim ownership 合同，也没有失主判断、租约和崩溃恢复边界。
- 禁止：覆盖已有 claim；按 mtime 抢占；owner 仍存活时回收；已 launched/result/error 的任务重新排队；只凭单次扫描宣称 exactly-once。
- 正确方案：每个 UUID v4 任务先用 `claim.lock` 的 `O_CREAT|O_EXCL` 独占创建，写入 Broker instance/PID/创建时间和 15 秒 lease；lease 过期且 owner 已失效才写 `recovery.json`、清理失效 claim 并重新排队；有效 result 优先于 error/cancel，Worker 清理终态目录不产生伪造失败。
- 自动验证门槛：双 Broker 竞争只能有一个 Popen；存活 claim 不回收；失主过期 claim 可恢复；launched/result/error 不重复启动；Worker 清理 result 后 Broker 不写 `LOCAL_RECOGNITION_RESULT_MISSING`。

## P054 threaded preview 必须三态控制

- 症状：单一 `threadedPreviewEnabled` 布尔值无法区分关闭、只诊断识别和允许正式批注预览的风险等级。
- 根因：识别链稳定性验收与正式 WPS 文档写入被同一个开关绑定，容易在真实证据不足时误开启 Preview Batch。
- 禁止：全局硬编码 `true`；诊断失败回退旧同步预览；diagnostic 模式写批注或格式；未完成真实 20/200/1000 识别就开启 enabled。
- 正确方案：`disabled` 拒绝线程识别，`diagnostic` 只跑 Worker snapshot/Broker recognition 与 blocks/binding 校验，`enabled` 才调用现有 Preview Batch；任何模式都不回退同步旧链。v1.3.2 默认保持 `diagnostic` + `threadedPreviewEnabled=false`。
- 自动验证门槛：Node 测试覆盖三态、diagnostic 零写入、enabled 走 Preview Batch 和无同步 fallback；真实 WPS 20/200/1000 证据完成前 Looper 状态必须保持 `READY_FOR_REAL_WPS_VALIDATION`。

## P055 Worker 清理终态任务与 Broker reap 存在竞态

- 症状：Worker 已读到有效 `result.json` 并删除任务目录，Broker 下一轮 reap 找不到目录，却把任务写成 `LOCAL_RECOGNITION_RESULT_MISSING`。
- 根因：Worker 的终态清理可能先于 Broker 读取 result；Broker 把“结果已被消费”的缺失目录误判为“识别器没有结果”。
- 禁止：任务目录消失后重新创建 heartbeat/error；用 status 的旧 `last_error_code` 代替当前任务结果；在 Worker 已收到有效 result 后覆盖为失败。
- 正确方案：active recognizer 的任务目录消失时等待进程退出并关闭 active，不重建目录、不生成伪造错误；成功 result 清空当前 Broker 错误码；所有客户端清理必须同时清除 `claim.lock`。
- 自动验证门槛：Python 回归覆盖 result 后目录清理；安装后的 Broker smoke 通过且 status `last_error_code` 为空；TypeScript recognition-client 和 WPS adapter 清理列表包含 `claim.lock`。

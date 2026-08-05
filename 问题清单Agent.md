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

## P015 WPS 本级虚拟环境与 wheel 安装被上级源码绕过

- 症状：用户要求恢复或重装 wheel 后，`pip show docxtool` 在 WPS 本级 `.venv` 中为空，或 9528 服务仍能运行但实际从上级 `..\src` 加载 `docxtool`，导致 wheel 重装不生效。
- 根因：WPS 脚本曾指向 `D:\PycharmProjects\docxtool\.venv`，并把 `D:\PycharmProjects\docxtool\src` 放入 `PYTHONPATH`；这会绕过 `D:\PycharmProjects\docxtool\wps\.venv` 中安装的 wheel。
- 禁止：WPS 插件运行、验证或服务启动时依赖上级 `.venv` 或上级 `src`；不得用“接口能通”证明 wheel 已恢复。
- 正确方案：WPS 项目固定使用 `D:\PycharmProjects\docxtool\wps\.venv`；local-agent 与 command-service 通过本仓库源码路径加载，`docxtool` 只能来自本级 `.venv` 已安装的 wheel；`local-agent` 依赖版本必须与当前 wheel 版本一致。
- 自动验证门槛：`wps\.venv\Scripts\python.exe -m pip show docxtool` 显示当前 wheel 版本；Python 直接导入路径位于 `wps\.venv\Lib\site-packages\docxtool`；9528 重启后真实识别返回 78 个段落 locator verified 和 1 个跳过的 table block；`scripts\verify-all.ps1` PASS。

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

# WPS 项目补充规则

## 工作目录约束

本轮及后续默认只在 `D:\PycharmProjects\wps` 工作，不再修改 `D:\PycharmProjects\docxtool`。
所有命令、读写、测试和 Git 操作默认以 `D:\PycharmProjects\wps` 为仓库根目录。
只有在用户明确点名旧仓库或要求同步旧仓库时，才可跨目录操作；跨目录操作前必须先说明具体原因、目标路径和是否只读。

每次任务结束前，必须更新 `docs/交接文档.md`。交接文档至少包含：当前结论、实际改动、自动验证、真实 WPS 验收状态、未解决问题、下一步严格顺序、生成文件路径，以及 commit/push 状态。

不得把未完成的真实 WPS 验收写成通过；保存后的 DOCX/OOXML 属性检查是格式能力通过的必要条件。

每次修改 WPS 插件前后，必须阅读并执行 `docs/问题清单Agent.md`。发现新的可复发问题时，必须在本轮结束前补充该清单，写清症状、根因、禁止做法、正确方案和自动验证门槛；不得只在聊天或交接文档中临时说明。

本机链路分为三类，职责不得混用：

1. WPS Control Server 生产编排链路：只监听 `127.0.0.1` 的随机高位端口；endpoint manifest 必须包含 instance、PID、进程创建时间、Bearer token、版本、合同版本和心跳，不能使用固定 `9528`，不能监听 `0.0.0.0`。该链路承载远程/受控部署形态的 `RemoteHttpsTransport`，识别结果必须经 Schema、版本、能力和 Hash 四重校验后才能进入命令生成。
2. 本地识别执行链路：识别仍必须通过 `docxtool-recognize.exe` 本地 runtime；Control Server/Worker 通过受校验的任务合同调用，不得接受任意 EXE、脚本或命令行；runtime 缺失时明确报错。该链路承载本机直连部署形态的 `LocalFileQueueTransport`：由 `main.py` 管理的无端口 Job Broker 文件队列领取任务，禁止从 Worker/Host 直接 `ShellExecute` 启动识别。
3. 旧 E2E/诊断链路：仅在脚本或用户明确要求时使用 `3889` 静态加载项和 `9528` 本地统一服务；不得让旧服务替代生产 Control Server，也不得把旧 `local-agent` 或 `command-service` 语义重新接回生产链。

生产执行链的识别提交按部署形态二选一：本机直连使用 `LocalFileQueueTransport`（第 2 条），远程/受控编排使用 `RemoteHttpsTransport`（第 1 条 Control Server）；两者都是受校验合同，生产链同一时刻只启用其一，任何一条都不得混入 9528 旧链路。

Control Server 必须由 `main.py` 或用户级启动器在 WPS 之外启动；WPS UI 主线程不得现场启动 Python、EXE、PowerShell 或等待 HTTP。所有生产 HTTP 请求由 Dedicated Worker 的 `ControlTransport` 发出，服务端只负责编排和 JSON 合同，不直接访问 WPS API。识别快照由主线程按批采集纯数据后交给 Worker；Worker 负责分批读取快照、document_token/revision/snapshot_hash 计算、识别协调和命令批次控制，分批调用 `WpsCommandExecutor`，每个待写目标执行前必须做局部 Hash 核验；Worker 不得访问或接收 `Application`、`Document`、`Range` 等宿主对象。

## 正式执行链（format_document 一键排版）

用户点击"一键排版"后，生产执行链固定为：检查活动文档、只读状态、保护状态和保存路径 → 保存当前文档 → Worker 分批读取识别快照 → 计算 document_token、revision、snapshot_hash → 按部署形态提交给 `LocalFileQueueTransport` 或 `RemoteHttpsTransport` → docxtool 返回 `RecognitionResult` JSON → Schema、版本、能力和 Hash 四重校验 → 重新读取核验快照并确认文档未变化 → 本地 `LocalFormatCommandGenerator` 生成命令 → Worker 分批调用 `WpsCommandExecutor`，每个目标执行前局部 Hash 核验 → 全部执行成功后执行后检查 → 自动保存当前文档。

- 识别后、执行前的文档变化判定以正文 SHA-256、段落数、段落顺序、节数和文档身份为准，不得因批注导致的格式指纹变化误报 `DOCUMENT_CHANGED`。
- 禁止批次间全文 `activeRevision()` 扫描；每批命令有硬上限；目标变化拒绝、写入读回、失败分批回滚。
- 自动保存后必须重新读取 DOCX/OOXML 复查，不能只靠即时读回；未完成真实 WPS 保存后验收前不得写 PASS。

除非服务异常、构建必须重载或用户明确要求，不得在任务结束时停止或重复 prepare；若 session token 被轮换，必须同步完整重启 WPS 宿主，禁止让旧 WebView 继续使用旧 token。

## 自动版本与 GitHub 发布

用户已明确授权：每次完成“大改”后自动更新版本并推送 GitHub，不再等待单独的提交提示。这里“大改”包括新功能、协议/合同变化、线程架构变化、正式执行链变化和影响用户体验的 WPS 宿主修复。

发布规则：

1. 普通代码修复或会进入产品包的文档/测试改动递增补丁号；新功能、协议或架构改动递增次版本号；大版本号只能在用户明确确认后递增。仅流程规则、交接记录或审阅附件的文档变更不改变产品版本，除非用户明确要求发布该规则/文档。
2. 根项目 package.json 与 apps/classified-offline/package.json 的版本号必须同步；构建信息由构建脚本重新生成，不能手工伪造 build id。
3. 发布前运行 npm test、npm run verify:all、npm run verify:local-direct 和 git diff --check；若真实 WPS 尚未通过，只能如实写入交接文档，不能把版本标为验收通过。
4. 确认远程必须是 `ssh://git@ssh.github.com:443/7654321x/wps--plugin.git`，提交全部受管理代码，提交消息使用 `release: vX.Y.Z ...`，然后使用 `git push origin HEAD:main` 推送；不要使用裸的 `git push HEAD:main`，因为 Git 会把 `HEAD:main` 误当成远程名称。
5. 推送后核对远程 refs/heads/main 与本地提交一致、工作树干净，并在 `docs/交接文档.md` 记录版本、提交、推送结果和未解决问题。
6. `.runtime/`、除根目录 `wps-plugin-debug.log` 外的日志、运行时 EXE、用户 DOCX、测试工作副本和 `local_recycle/` 不得提交；`wps-plugin-debug.log` 是用户明确允许的唯一原始日志例外，但每次发布前必须完成敏感信息扫描，扫描不通过即暂停推送。

### 固定 GitHub 上传清单

以下规则是 WPS 仓库的固定上传流程，不再按临时猜测决定提交范围。除“必须忽略或禁止提交”的内容外，提交应覆盖工作树中全部可版本化的项目文件，包括本轮未直接修改但已经存在的受管文件；不得因其属于 Agent、文档、测试或辅助资料而遗漏。

#### 允许提交的内容

- `apps/`、`src/`、`packages/`、`local-runtime/`、`scripts/`、`tests/` 中受 Git 管理的源码、协议、脚本和自动化测试。
- 根目录和应用目录的 `package.json`、`package-lock.json`、TypeScript/Python 配置、清单、Schema、资源模板及加载项清单。
- 根目录的规则入口 `AGENTS.md`、`docs/AGENTS.md`、`docs/问题清单Agent.md`、`docs/交接文档.md` 和与本次变更直接相关的项目文档。
- `agent/` 中受管理的 Agent 说明、审阅证据、流程资料和目录结构；发布到 GitHub 时必须与源码、测试和 `docs/` 一起提交。
- 根目录 `wps-plugin-debug.log` 原始诊断日志：仅在发布前通过敏感信息扫描时提交，便于跨环境检索实际问题；不提交轮转副本或其他 `*.log` 文件。
- 构建脚本生成且已受 Git 管理的 `apps/classified-offline/ui/build-info.js`；必须由 `npm run build:classified` 生成，禁止手工伪造 build id。
- 用户明确要求提供审阅证据时，可提交命名明确的 `.patch` 文件；文件必须只由指定 commit/range 生成，并在 `docs/交接文档.md` 记录路径、来源 commit、SHA-256 和用途。审阅 patch 是证据附件，不是生产源码。标准 diff 的空上下文行可能触发 whitespace 检查，禁止为了消除误报而改写 patch；有 patch 时只对其他文件执行 `git diff --check -- . ':(exclude)*.patch'`，同时做来源、哈希和禁带内容扫描。

#### 必须忽略或禁止提交的内容

- `.runtime/`、`node_modules/`、`.venv/`、`dist/`、`wps-addon-publish/`、`.idea/`、`.reasonix/`、`local_recycle/`。
- 运行时 EXE、wheel、除根目录 `wps-plugin-debug.log` 外的日志、调试输出、session token、PID/status 文件、临时请求/结果文件和本地配置；包括其他 `*.log`、`*.whl`、`*.tsbuildinfo`、`__pycache__/`、`*.pyc`。
- 用户 DOCX、测试工作副本、渲染副本和测试运行产物；包括 `*.docx`、`tests/e2e-work/`、`tests/*工作副本.docx`、`tests/~$*.docx` 及各类 e2e render 目录。
- `apps/classified-offline/ui/e2e-session.js`、`wps-plugin-debug.log.1` 至轮转副本及任何包含令牌、绝对本机路径或用户数据的文件。根目录 `wps-plugin-debug.log` 仅在扫描无此类内容时例外允许提交。
- 任意临时 patch、截图、压缩包和审阅临时文件；只有 `agent/reviews/` 中由用户明确要求或项目发布流程生成、并完成来源/哈希/禁带扫描的审阅 patch 可以提交。

#### 发布前固定顺序

1. 只在 `D:\PycharmProjects\wps` 工作；读取 `docs/问题清单Agent.md`，确认 `git status --short`、当前分支和远程 URL；远程必须精确匹配上面的 WPS SSH 地址。
2. 用 `git diff --name-only` 和 `git diff --cached --name-only` 审核文件清单；对每个新增文件执行 `git check-ignore -v`，发现禁止文件立即暂停。若 `wps-plugin-debug.log` 在清单中，必须额外扫描 credential assignment、Bearer、API token 前缀、Windows 绝对路径和带凭据 URL；任一命中即暂停。扫描完成后，除禁止项外应覆盖全部可版本化文件。
3. 代码或版本变更必须同步根 `package.json`、`package-lock.json`、`apps/classified-offline/package.json`，运行 `npm run build:classified` 生成构建信息，并在 `docs/交接文档.md` 新增当前版本条目。交接文档版本必须与实际发布版本一致；历史条目不得回改。
4. 依次独立运行 `npm test`、`npm run verify:all`、`npm run verify:local-direct`、`git diff --check`；若提交审阅 patch，使用 `git diff --check -- . ':(exclude)*.patch'`；每个外部命令结束后立即检查退出码，前一步失败不得进入下一步或 push。
5. 禁带扫描通过后使用 `git add --all` 暂存全部可版本化文件（Git 忽略项不会被加入），再逐项审阅 `git diff --cached --name-only`、`git diff --cached --check -- . ':(exclude)*.patch'` 和 `git diff --cached --stat`；发现任何禁止项立即取消暂存并暂停。发布提交使用 `release: vX.Y.Z ...`，纯交接/审阅附件提交使用 `docs: ...`。
6. 提交后使用 `git push origin HEAD:main`；随后比较 `git rev-parse HEAD` 与 `git ls-remote origin refs/heads/main`，再次确认 `git status --short --branch` 干净，并把 commit、push、版本、构建号和未解决问题写入 `docs/交接文档.md`。

#### 快速发布模板

```powershell
pwsh -NoProfile -Command "git status --short --branch"
pwsh -NoProfile -Command "git remote get-url origin"
pwsh -NoProfile -Command "npm run build:classified"
pwsh -NoProfile -Command "npm test"
pwsh -NoProfile -Command "npm run verify:all"
pwsh -NoProfile -Command "npm run verify:local-direct"
pwsh -NoProfile -Command "git diff --check"
pwsh -NoProfile -Command "rg --pcre2 -n -i '(authorization|cookie|password|secret|session[_-]?token|access[_-]?token)\\s*[:=]\\s*[^\\s,;]+|bearer\\s+[A-Za-z0-9._~+/\\-]+|(?:sk|fc|agt)_[A-Za-z0-9_-]{12,}|(?<![A-Za-z])[A-Za-z]:[\\/]' wps-plugin-debug.log; if ($LASTEXITCODE -eq 0) { exit 1 } elseif ($LASTEXITCODE -ne 1) { exit $LASTEXITCODE }"
pwsh -NoProfile -Command "git add --all"
pwsh -NoProfile -Command "git diff --cached --check -- . ':(exclude)*.patch'"
pwsh -NoProfile -Command "git commit -m 'release: vX.Y.Z <说明>'"
pwsh -NoProfile -Command "git push origin HEAD:main"
pwsh -NoProfile -Command "git rev-parse HEAD; git ls-remote origin refs/heads/main; git status --short --branch"
```

#### 审阅 patch 上传模板

只有用户明确要求时才生成并上传 patch；不把 patch 当作代码发布，也不把它混入 `.runtime` 或其他运行产物。

```powershell
pwsh -NoProfile -Command "git show <commit> --stat --patch --find-renames > <明确的-review.patch>"
pwsh -NoProfile -Command "Get-FileHash -Algorithm SHA256 -LiteralPath '<明确的-review.patch>'"
pwsh -NoProfile -Command "rg -n -i '\.venv|node_modules|\.runtime|\.log|\.docx|local_recycle|token|session' '<明确的-review.patch>'"
pwsh -NoProfile -Command "git add -- <明确的-review.patch>"
pwsh -NoProfile -Command "git diff --cached --check -- . ':(exclude)*.patch'"
pwsh -NoProfile -Command "git commit -m 'docs: upload review patch'"
pwsh -NoProfile -Command "git push origin HEAD:main"
```

生成后必须检查 patch 的来源 commit、文件大小、SHA-256 和内容中没有 `.venv`、`.runtime`、日志、DOCX、token 或本地配置；并在 `docs/交接文档.md` 记录 patch 文件路径和上传 commit。

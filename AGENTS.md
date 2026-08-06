# WPS 项目补充规则

## 工作目录约束

本轮及后续默认只在 `D:\PycharmProjects\wps` 工作，不再修改 `D:\PycharmProjects\docxtool`。
所有命令、读写、测试和 Git 操作默认以 `D:\PycharmProjects\wps` 为仓库根目录。
只有在用户明确点名旧仓库或要求同步旧仓库时，才可跨目录操作；跨目录操作前必须先说明具体原因、目标路径和是否只读。

每次任务结束前，必须更新仓库根目录的 `交接文档.md`。交接文档至少包含：当前结论、实际改动、自动验证、真实 WPS 验收状态、未解决问题、下一步严格顺序、生成文件路径，以及 commit/push 状态。

不得把未完成的真实 WPS 验收写成通过；保存后的 DOCX/OOXML 属性检查是格式能力通过的必要条件。

每次修改 WPS 插件前后，必须阅读并执行根目录 `问题清单Agent.md`。发现新的可复发问题时，必须在本轮结束前补充该清单，写清症状、根因、禁止做法、正确方案和自动验证门槛；不得只在聊天或交接文档中临时说明。

本机链路分为两类，不得混用：

1. 本地直连生产链路：识别必须通过 `docxtool-recognize.exe` 本地 runtime；缺失时明确报错，不得回退到 `9528`。
2. 旧 E2E/诊断链路：仅在脚本或用户明确要求时使用 `3889` 静态加载项和 `9528` 本地统一服务；不得重新引入第二个本机业务端口。

除非服务异常、构建必须重载或用户明确要求，不得在任务结束时停止或重复 prepare；若 session token 被轮换，必须同步完整重启 WPS 宿主，禁止让旧 WebView 继续使用旧 token。

## 自动版本与 GitHub 发布

用户已明确授权：每次完成“大改”后自动更新版本并推送 GitHub，不再等待单独的提交提示。这里“大改”包括新功能、协议/合同变化、线程架构变化、正式执行链变化和影响用户体验的 WPS 宿主修复。

发布规则：

1. 普通代码修复或会进入产品包的文档/测试改动递增补丁号；新功能、协议或架构改动递增次版本号；大版本号只能在用户明确确认后递增。仅流程规则、交接记录或审阅附件的文档变更不改变产品版本，除非用户明确要求发布该规则/文档。
2. 根项目 package.json 与 apps/classified-offline/package.json 的版本号必须同步；构建信息由构建脚本重新生成，不能手工伪造 build id。
3. 发布前运行 npm test、npm run verify:all、npm run verify:local-direct 和 git diff --check；若真实 WPS 尚未通过，只能如实写入交接文档，不能把版本标为验收通过。
4. 确认远程必须是 `ssh://git@ssh.github.com:443/7654321x/wps--plugin.git`，提交全部受管理代码，提交消息使用 `release: vX.Y.Z ...`，然后使用 `git push origin HEAD:main` 推送；不要使用裸的 `git push HEAD:main`，因为 Git 会把 `HEAD:main` 误当成远程名称。
5. 推送后核对远程 refs/heads/main 与本地提交一致、工作树干净，并在交接文档.md 记录版本、提交、推送结果和未解决问题。
6. .runtime/、日志、运行时 EXE、用户 DOCX、测试工作副本和 local_recycle/ 不得提交；发现发布风险文件或门禁失败时暂停推送并报告。

### 固定 GitHub 上传清单

以下规则是 WPS 仓库的固定上传流程，不再按临时猜测决定提交范围。

#### 允许提交的内容

- `apps/`、`src/`、`packages/`、`local-runtime/`、`scripts/`、`tests/` 中受 Git 管理的源码、协议、脚本和自动化测试。
- 根目录和应用目录的 `package.json`、`package-lock.json`、TypeScript/Python 配置、清单、Schema、资源模板及加载项清单。
- 根目录 `AGENTS.md`、`问题清单Agent.md`、`交接文档.md` 和与本次变更直接相关的项目文档。
- 构建脚本生成且已受 Git 管理的 `apps/classified-offline/ui/build-info.js`；必须由 `npm run build:classified` 生成，禁止手工伪造 build id。
- 用户明确要求提供审阅证据时，可提交命名明确的 `.patch` 文件；文件必须只由指定 commit/range 生成，并在 `交接文档.md` 记录路径、来源 commit、SHA-256 和用途。审阅 patch 是证据附件，不是生产源码。标准 diff 的空上下文行可能触发 whitespace 检查，禁止为了消除误报而改写 patch；有 patch 时只对其他文件执行 `git diff --check -- . ':(exclude)*.patch'`，同时做来源、哈希和禁带内容扫描。

#### 必须忽略或禁止提交的内容

- `.runtime/`、`node_modules/`、`.venv/`、`dist/`、`wps-addon-publish/`、`.idea/`、`.reasonix/`、`local_recycle/`。
- 运行时 EXE、wheel、日志、调试输出、session token、PID/status 文件、临时请求/结果文件和本地配置；包括 `*.log`、`*.whl`、`*.tsbuildinfo`、`__pycache__/`、`*.pyc`。
- 用户 DOCX、测试工作副本、渲染副本和测试运行产物；包括 `*.docx`、`tests/e2e-work/`、`tests/*工作副本.docx`、`tests/~$*.docx` 及各类 e2e render 目录。
- `apps/classified-offline/ui/e2e-session.js`、`wps-plugin-debug.log*` 及任何包含令牌、绝对本机路径或用户数据的文件。
- 未经用户明确要求的 patch、截图、压缩包和审阅临时文件；不得用 `git add .` 或 `git commit -a` 把它们带入提交，必须使用显式文件清单。

#### 发布前固定顺序

1. 只在 `D:\PycharmProjects\wps` 工作；读取 `问题清单Agent.md`，确认 `git status --short`、当前分支和远程 URL；远程必须精确匹配上面的 WPS SSH 地址。
2. 用 `git diff --name-only` 和 `git diff --cached --name-only` 审核文件清单；对每个新增文件执行 `git check-ignore -v`，发现禁止文件立即暂停。
3. 代码或版本变更必须同步根 `package.json`、`package-lock.json`、`apps/classified-offline/package.json`，运行 `npm run build:classified` 生成构建信息，并在交接文档新增当前版本条目。交接文档版本必须与实际发布版本一致；历史条目不得回改。
4. 依次独立运行 `npm test`、`npm run verify:all`、`npm run verify:local-direct`、`git diff --check`；若提交审阅 patch，使用 `git diff --check -- . ':(exclude)*.patch'`；每个外部命令结束后立即检查退出码，前一步失败不得进入下一步或 push。
5. 只暂存明确的受管文件，运行 `git diff --cached --check -- . ':(exclude)*.patch'` 和 `git diff --cached --stat`；发布提交使用 `release: vX.Y.Z ...`，纯交接/审阅附件提交使用 `docs: ...`。
6. 提交后使用 `git push origin HEAD:main`；随后比较 `git rev-parse HEAD` 与 `git ls-remote origin refs/heads/main`，再次确认 `git status --short --branch` 干净，并把 commit、push、版本、构建号和未解决问题写入 `交接文档.md`。

#### 快速发布模板

```powershell
pwsh -NoProfile -Command "git status --short --branch"
pwsh -NoProfile -Command "git remote get-url origin"
pwsh -NoProfile -Command "npm run build:classified"
pwsh -NoProfile -Command "npm test"
pwsh -NoProfile -Command "npm run verify:all"
pwsh -NoProfile -Command "npm run verify:local-direct"
pwsh -NoProfile -Command "git diff --check"
pwsh -NoProfile -Command "git add -- <明确文件列表>"
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

生成后必须检查 patch 的来源 commit、文件大小、SHA-256 和内容中没有 `.venv`、`.runtime`、日志、DOCX、token 或本地配置；并在交接文档记录 patch 文件路径和上传 commit。

# WPS 实机验证清单

当前环境检测到 WPS 文字 12.1.0.26895 正在运行，且 `wpsjs debug` 已登记涉密版；受自动化策略限制，Codex 不会操作可见 WPS 窗口。因此状态为 `REAL_WPS_E2E_PARTIAL`，真实验收由操作员完成。

## 第三阶段操作步骤

1. 在 `wps` 目录运行 `npm run e2e:classified:prepare`。预期静态资源、本地统一服务和注册均为 `PASS`，并输出 `E2E_SESSION_READY`；命令不会输出路径、正文或令牌。
2. 运行 `npm run e2e:classified:status`，确认 static resources、local-agent、command-service（统一入口）和 debug registration 均为 `PASS`。识别与命令均通过 9528，9529 不应监听。
3. 关闭所有 WPS 窗口，再重新打开 WPS 文字；打开本次会话生成的工作副本。不要打开 `tests/fixtures` 中的原始基准文件。
4. 确认 `Docxtool 涉密离线版` Ribbon 可见，点击“打开任务窗格”，进入“开发验证”。重复点击不应增加窗格。
5. 依次手工点击“确认 Ribbon 与任务窗格”“检查宿主环境”“检查活动文档”“检查本地服务”。正常结果记录为 `PASS`；未加载时记录稳定错误码，例如 `WPS_HOST_NOT_DETECTED` 或 `LOCAL_SERVICE_UNAVAILABLE`。
6. 点击“运行只读完整链路”前先执行活动文档检查。当前页面会拒绝不属于本会话工作副本的文档，错误码为 `E2E_TEST_DOCUMENT_REQUIRED`。只读链路尚未完整桥接时会如实记录 `HOST_CHAIN_NOT_WIRED`，不得继续写入。
7. 对每一类写入测试，必须单独确认。页面在每次测试中读取原属性、写入测试值、读回并恢复；它从不在页面加载时自动写入。顺序为对齐、字体、缩进、间距、页面设置。
8. “测试失败恢复”使用仅开发页面内的 `FAIL_AFTER_COMMAND` 故障点，验证恢复后的读回；该故障点不接收服务端输入，生产构建不包含它。
9. 文档变化测试：先点击“记录预览 revision”，手工修改或插入一个段落，再点击“验证文档变化检测”。预期结果为 `DOCUMENT_CHANGED`。随后重新准备会话，不得继续使用旧预览。
10. 点击“导出脱敏测试结果”，关闭 WPS 后运行 `npm run e2e:classified:report`；最后执行 `npm run e2e:classified:stop`。stop 只停止本项目记录的开发进程，不会结束 WPS。

结果仅保存在 `wps/.runtime/e2e/`，该目录被忽略。结果包含会话、版本、阶段、状态和稳定错误码；不包含正文、Range.Text、文件名、完整路径、原始协议对象、令牌或 traceback。

任务窗格现在会自动执行只读诊断。若出现失败，先查看顶部的“首个根因”和对应稳定错误码；可用“只检测失败项”“重新检测本地服务”或单项“重新检测”重试。不要把浏览器的 `Failed to fetch` 当作最终结论。写入按钮只有全部前置诊断通过后才会启用。

高级验证支持“自动测试段落”和“当前选区”。`wps-jsapi 1.0.5` 声明确认 `Application.Selection`、`Selection.Range`、`Range.Start/End` 与 `Range.Paragraphs`；当前选区无法读取时返回 `SELECTION_API_UNSUPPORTED`，可切回自动目标。对齐可选左、居中、右、两端、分散；字体固定测试 Arial、宋体、16 pt、粗体；缩进为 2/1/1 字符；间距为 6/6/固定 28 pt；页面设置仅作用于当前节。

写入后页面会显示原值、目标值、读回值与稳定错误码，并保持效果 10 秒。可选择“立即恢复”或“延长 10 秒”；默认恢复后再次读回。开发写入只允许 E2E 工作副本，绝不在普通用户文档上启用。

完成官方加载项注册后，逐项验证：

1. 加载涉密版和联网版，确认 Ribbon 名称和加载项 ID 不同。
2. 打开已保存的 DOCX，确认只读识别会调用本地 recognition agent。
3. 确认预览不写入文档。
4. 逐项探测 ActiveDocument、段落、Range、Font、ParagraphFormat、PageSetup 与撤销能力。
5. 仅在官方成员参考和运行时探测均确认后，开启对应 capability。
6. 验证文件修改、目标哈希变化、服务断开均得到稳定错误码。
7. 对每一种已开启写入能力验证失败补偿和撤销行为。

专用脱敏文档的每项写入按“记录原属性 → 写入 → 读回 → 恢复 → 再读回”执行。未完成此流程的 API 必须保持 `UNSUPPORTED`，不得用类型声明或 Mock 结果替代实机结果。

# WPS 格式事务与恢复

状态：`MOCK_TESTED`，`REAL_WPS_WRITE_CONFIRMED=NOT_TESTED`。

`WpsApiDocumentExecutor` 在每一条白名单命令写入前，只在内存中保存相关格式属性：字体、段落格式或页面设置。写入后立即读取同一属性验证；后续任一命令失败时，按相反顺序恢复已经成功的命令。恢复失败返回 `ROLLBACK_FAILED`。

执行开始时重新计算由段落文本、段落数量和保存状态组成的 revision；与预览 revision 不一致时返回 `DOCUMENT_CHANGED`，不定位目标也不写入。目标定位还会校验目标文本 SHA-256；不会记录段落正文。

此机制不是 WPS 的撤销事务，也不承诺一次 Ctrl+Z。未通过专用脱敏测试文档的“写入—读回—恢复—读回”验证前，`WpsCapabilityProvider` 不会发布写入 capability，生产加载项不得执行写入。

开发交互不会在写入后立刻恢复：成功读回后进入 `holding_for_observation`，默认 10 秒，再执行恢复与恢复读回。操作员可立即恢复或延长 10 秒；这些控制只出现在开发任务窗格。

# WPS API 映射与支持状态

实机环境：Windows 上运行 WPS 文字 12.1.0.26895。安装目录包含 jswpsapi.dll、jsapiservice.dll、webextension.dll 和内置任务窗格资源，确认该安装具有客户端 JS API 运行组件。成员依据与版本记录见 WPS_OFFICIAL_REFERENCES.md。

| 语义命令或能力 | WPS 对象/成员 | 状态 | 已验证版本 | 依据与限制 |
|---|---|---|---|---|
| 加载项任务窗格运行时 | WPS 内置 web task pane 资源 | 运行组件存在 | 12.1.0.26895 | 本机安装目录实测；第三方加载项注册与启动模板仍需使用官方 wpsjs 工具实测。 |
| 当前文档入口 | Application.ActiveDocument | TYPE_DECLARATION_CONFIRMED；NOT_TESTED | 无 | `wps-jsapi 1.0.5` 类型声明；尚未进入真实加载项上下文。 |
| 预览批注目标 Range | Paragraph.Range.Start/End/SetRange | TYPE_DECLARATION_CONFIRMED；MOCK_TESTED；REAL_WPS_WRITE_CONFIRMED=NOT_TESTED | 无 | 必须在原 Paragraph.Range 上用 SetRange 收窄；禁止用 Document.Range 重建已绑定的段落子范围。 |
| 段落字体 | Paragraph.Range.Font；Font.Name/NameFarEast/Size/Bold | TYPE_DECLARATION_CONFIRMED；MOCK_TESTED；REAL_WPS_WRITE_CONFIRMED=NOT_TESTED | 无 | 默认 capability 关闭；只能在脱敏测试文档实机“写入—读回—恢复”后启用。 |
| 段落对齐/缩进/间距 | Paragraph.Range.ParagraphFormat | TYPE_DECLARATION_CONFIRMED；MOCK_TESTED；REAL_WPS_WRITE_CONFIRMED=NOT_TESTED | 无 | 对齐枚举固定映射 left=0、center=1、right=2、justify=3、distributed=4；缩进使用 CharacterUnit* 成员，间距为点。 |
| 页面设置 | Document.PageSetup | TYPE_DECLARATION_CONFIRMED；MOCK_TESTED；REAL_WPS_WRITE_CONFIRMED=NOT_TESTED | 无 | 协议厘米值转换为 point（28.3464567 point/cm），不创建新分节。 |
| 自定义撤销记录 | 未确认 | 不支持执行 | 无 | 当前使用 Mock 补偿事务验证语义；不声称真实 Ctrl+Z 可用。 |

因此，默认 `WpsCapabilityProvider` 不发布任何写入 capability。即使对象成员存在，也不代表真实宿主允许写入；未做专用文档实机回读前，执行器返回 `CLIENT_CAPABILITY_MISSING`，而不是调用 WPS 写接口。

第三阶段的开发验证记录保存在 `.runtime/capabilities/<session-id>/`，每项包括 WPS 版本、插件版本、jsapi 版本、读、写、读回、恢复和最终状态。记录只服务于当前开发会话，不能自动提高未来用户机器的 capability；正式 WPS 适配器仍以默认关闭为准。

选区：`wps-jsapi 1.0.5` 类型声明确认 `WpsApplication.Selection`、`WpsSelection.Range`、`Start`、`End` 与 `Paragraphs`。状态为 `TYPE_DECLARATION_CONFIRMED`；当前选区实际读取仍须在任务窗格中实机验证，失败时开发验证退回自动测试段落。

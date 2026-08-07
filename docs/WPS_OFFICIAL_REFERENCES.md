# WPS 官方依据

## 工具与类型声明

| 项目 | 实际版本 | 依据 | 状态 |
|---|---:|---|---|
| wpsjs | 2.2.3 | `wpsjs --version`、npm 包文字模板 | 已确认 |
| wps-jsapi | 1.0.5 | npm 包 wps-jsapi 的 TypeScript 对象模型声明 | 已确认 |
| WPS 文字 | 12.1.0.26895 | 本机运行进程与安装目录 | 已确认 |

## 模板结构

wpsjs 自带文字模板位于 packages/@wps-jsapi/wps。模板使用 manifest.xml、ribbon.xml、main.js、js/ribbon.js 和 ui/taskpane.html。

模板直接示例：

- window.Application.ActiveDocument
- window.Application.CreateTaskPane(url)
- window.Application.GetTaskPane(id)
- window.Application.PluginStorage
- window.Application.ApiEvent

Ribbon XML 使用 CustomUI 2006/01 命名空间，并通过 OnAddinLoad 和 OnAction 回调连接 JavaScript。

官方 wpsjs 2.2.3 源码进一步确认：`debug` 命令为用户级开发注册入口，写入 AppData/kingsoft/wps/jsaddons/publish.xml 并启动本地资源服务；`publish --serverUrl <serverUrl>` 命令只生成用于分发的 publish.html，不直接登记本机加载项。`unpublish` 没有删除 debug 注册的实现，因此不能把它称为本机调试卸载。两者均未显示管理员权限要求；已登记的运行中 WPS 需要重启或刷新加载项后才会读取配置。

## 类型声明成员

以下成员来自 wps-jsapi 1.0.5 的 src/lib.wps.d.ts：

| 对象 | 成员 | 可读/写 | 用途 |
|---|---|---|---|
| WpsApplication | ActiveDocument | 读 | 当前文档 |
| WpsApplication | CreateTaskPane | 调用 | 创建任务窗格 |
| WpsDocument | FullName、Saved、PageSetup | 读；PageSetup 可写 | 保存检查与页面设置 |
| WpsDocument | Paragraphs | 读 | 段落集合 |
| WpsParagraph | Range | 读 | 目标段落范围 |
| WpsRange | Text、Start、End、SetRange、Font、ParagraphFormat | Text/Start/End 可读；SetRange 可调用；后两者可写 | 哈希、在原 Range 上收窄批注目标、字体和段落格式 |
| WpsFont | Name、NameFarEast、Size、Bold | 可写 | 字体命令 |
| WpsParagraphFormat | Alignment、CharacterUnitFirstLineIndent、CharacterUnitLeftIndent、CharacterUnitRightIndent、LineUnitBefore、LineUnitAfter、LineSpacingRule、LineSpacing、OutlineLevel | 可写 | 对齐、缩进、行单位间距与大纲级别 |
| WpsPageSetup | PageWidth、PageHeight、TopMargin、BottomMargin、LeftMargin、RightMargin | 可写 | 页面设置 |

枚举也由该声明给出：WpsWdParagraphAlignment 为 left=0、center=1、right=2、justify=3、distribute=4；WpsWdLineSpacing 的 exactly=4。

这些成员已进入共享 WPS 适配层，状态为 `TYPE_DECLARATION_CONFIRMED` 和 `MOCK_TESTED`，但尚未完成真实加载项发布后的逐项读回验证。因此 `REAL_WPS_READ_CONFIRMED`、`REAL_WPS_WRITE_CONFIRMED` 均为 `NOT_TESTED`；默认 capability 不会开启写入。

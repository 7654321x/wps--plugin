# WPS 客户端 JSAPI 调用方式调研

更新日期：2026-07-29  
适用范围：本项目的 Windows WPS 客户端加载项（非 WebOffice 服务端 API）。

## 已核实的官方入口

WPS 开放平台将 **客户端 JSAPI、JSSDK 与 Deeplink** 列为 WPS 客户端二次开发能力；其首页同时区分了服务端 OpenAPI、WebOffice 文档处理和 WPS 客户端能力。因此，本项目应使用客户端 JSAPI 读取和修改当前 WPS 文档，不能将文档交给服务端 OpenAPI 或 WebOffice 处理。

- 官方开放平台：https://open.wps.cn/
- 官方平台首页（客户端能力说明）：https://open.wps.cn/

官方成员参考目前通过交互式开放平台提供。接入真实 WPS 前，应使用目标安装版本与实际授权账号在该平台确认可用 API、加载项形态和权限要求；不得以非官方社区示例替代版本兼容性结论。

## 本项目采用的调用边界

WPS API 仅存在于 packages/wps-adapter 的未来真实实现中。应用层、命令服务、本地识别 Agent 均不得导入或调用它。

~~~text
FormattingCommand
  -> WpsApiExecutor（客户端）
  -> Application / ActiveDocument / Paragraph / Range
  -> 当前已打开的 WPS 文档
~~~

服务端只返回声明式命令，例如 paragraph.set_alignment；禁止返回 Application.ActiveDocument 对象表达式、JavaScript 或任何可执行脚本。

## 推荐初始化和能力探测

加载项启动时先探测宿主对象，再显示功能入口。不要使用 eval、new Function 或字符串拼接的对象访问。

~~~ts
interface WpsApplicationLike {
  ActiveDocument?: unknown;
  Version?: string;
}

export function getWpsApplication(): WpsApplicationLike | null {
  const candidate = (globalThis as { Application?: unknown }).Application;
  return candidate && typeof candidate === "object"
    ? candidate as WpsApplicationLike
    : null;
}

export function requireActiveDocument(): unknown {
  const application = getWpsApplication();
  if (!application?.ActiveDocument) {
    throw new Error("WPS_ACTIVE_DOCUMENT_UNAVAILABLE");
  }
  return application.ActiveDocument;
}
~~~

说明：

- Application.ActiveDocument 是当前项目规划中需要由客户端封装的文档入口。
- 不能假定所有 WPS 版本都支持同一对象成员、事务撤销能力或页眉页脚能力。
- CapabilityProvider 应以实测结果输出能力，不应按 WPS 版本号猜测。

## 读取当前文档的适配原则

真实 DocumentReader 应在客户端完成以下步骤：

1. 取得当前 ActiveDocument。
2. 验证当前文档类型与保存状态。
3. 生成仅在本机使用的 DOCX 临时快照，交给现有 recognition wheel。
4. 为当前段落建立本机定位信息：段落索引、文本完整 SHA-256、重复文本 occurrence index。
5. 在命令执行前重新计算 revision，防止识别期间用户修改文档。

段落正文、完整路径和临时 DOCX 均不得进入 CommandRequest。

## 声明式命令到 WPS 调用的映射

第一阶段只冻结语义命令，不在这里实现真实调用。后续 WpsApiExecutor 应通过编译期固定的处理器映射调用 WPS API：

| 命令 | WPS 客户端处理目标 | 允许的语义参数 |
|---|---|---|
| paragraph.set_font | 目标段落的字体对象 | font_family、font_size_pt、bold |
| paragraph.set_alignment | 目标段落的段落格式对象 | left、center、right、justify、distributed |
| paragraph.set_indent | 目标段落的段落格式对象 | 首行、左、右缩进（字符） |
| paragraph.set_spacing | 目标段落的段落格式对象 | 固定行距（pt）、段前/段后（行）、大纲级别 |
| section.set_page_setup | 当前节的页面设置对象 | 页宽高、上下左右页边距（cm） |

处理器必须先验证：

1. target_id、段落索引和文本 SHA-256 仍指向同一段；
2. 当前客户端声明支持 required_capability；
3. 参数处于协议范围；
4. 该命令属于白名单。

不匹配时跳过或回滚事务，不能按索引盲目写入其他段落。

## 事务与撤销

真实执行器应优先使用目标 WPS 版本提供的自定义撤销记录或等效机制，把一次排版归为一次用户可撤销操作。若目标版本不支持可靠事务：

- 在执行前保存最小可恢复状态；
- 遇到任一命令失败时停止；
- 明确返回 rolled_back: false 与失败原因；
- 不宣称已完成原子回滚。

第一阶段的 MockTransactionManager 和 MockDocumentExecutor 仅用于验证该业务语义，尚未调用真实 WPS API。

## 接入实机前的验证清单

- 在支持的 WPS 版本上确认 Application 和 ActiveDocument 可用。
- 确认段落、字体、段落格式、页面设置与撤销 API 的准确成员名及单位。
- 用只读文档、未保存文档、空文档、含表格/图片文档分别验证能力探测。
- 验证同一次命令集是否只生成一次撤销记录。
- 验证命令目标文本变化、段落重排、重复文本时会安全拒绝而非误改。
- 将逐版本结果补充到后续 docs/WPS_CAPABILITY_MATRIX.md。

## 当前结论

WPS 官方开放平台确认客户端 JSAPI 是正确的集成面；本项目的“本地识别 → 云端或本地命令 → 客户端原位执行”架构与该边界一致。具体对象成员和能力矩阵必须以目标 WPS 版本的官方交互式参考与实机验证为准，当前不应把未验证的 VBA、Office.js 或社区 API 名称直接写入生产执行器。

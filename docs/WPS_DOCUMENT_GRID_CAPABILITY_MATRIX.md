# WPS 文档网格能力矩阵

来源：本机 `wps-jsapi 1.0.5` 声明、`packages/wps-adapter/src/official-host.ts` 的 RuntimeProbe，以及根项目 `core.py` 的 OOXML 排版实现。

| 能力 | 类型声明 | 当前正式读回 | 严格持久化状态 |
| --- | --- | --- | --- |
| 页面尺寸、页边距、方向 | `WpsPageSetup` | 可读；正式写入后读回 | 待真实保存验证 |
| `LinesPage`、`CharsLine`、`LayoutMode` | `WpsPageSetup` | 可读 | 不足以表达严格网格 |
| `charSpace`、`linePitch` | 不存在 | UNSUPPORTED | UNSUPPORTED |
| 段落 `SnapToGrid` | `WpsParagraphFormat` | 可读/可写 | line_only 强制关闭 |
| Run `Spacing`、`Scaling` | `WpsFont` | 可读/可写 | line_only 归零/100% |
| Run `FitText` 布尔值 | 不存在（仅有方法或宽度成员） | UNSUPPORTED | UNSUPPORTED |
| `doNotExpand`、`useFELayout`、`balanceSingleByteDoubleByteWidth` | 不存在 | UNSUPPORTED | UNSUPPORTED |

结论：WPS JSAPI 1.0.5 不能完整持久化根项目的 `w:docGrid` 严格语义。因此 `strict_lines_and_chars` 固定返回 `DOCUMENT_CHARACTER_GRID_UNSUPPORTED`；正式默认使用 `line_only`，不写 `CharsLine`、`LinesPage` 或 `LayoutMode=1`。

根项目实际基线：Normal 东亚字体 `仿宋_GB2312`、拉丁字体 `Times New Roman`、16pt；A4 21×29.7cm，边距 3.7/3.5/2.8/2.6cm，22 行，28 字，固定 28pt。根项目通过 `floor((content_width_twips / 28 / 20 - 16) * 4096)` 写入 `charSpace`，并写入 `linePitch=560`。

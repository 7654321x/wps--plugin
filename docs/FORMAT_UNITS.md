# 格式单位

字体大小为 pt；首行、左、右缩进为字符，写入 `CharacterUnitFirstLineIndent`、`CharacterUnitLeftIndent`、`CharacterUnitRightIndent`，不要把字符数换成 cm 或 point。段前、段后在 Profile 和 WPS 中均为行，写入 `LineUnitBefore/LineUnitAfter`。固定行距本身为 pt；页面尺寸和边距为 cm，写入前转换为 point。

WPS 段落窗口中的段前、段后必须显示为“行”。`1 行` 直接写入行单位 1；不得先换算为 28 pt。只有固定行距继续显示为磅。

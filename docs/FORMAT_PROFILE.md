# 默认格式 Profile

唯一事实源是根项目的 `src/docxtool/resources/config/default-format.json`。运行 `python scripts/sync-default-format-profile.py` 后，命令服务包资源中的 `docxtool-default.json` 和 manifest 自动生成；`--check` 会拒绝过期结果。manifest 记录源文件 SHA-256 和 docxtool 1.3 版本。

Profile 保留中文字体、Times New Roman 西文字体、pt 字号、字符缩进、行单位段前段后、固定值行距以及厘米页面参数。段前段后始终写入 WPS `LineUnitBefore/LineUnitAfter`，不转换为磅。

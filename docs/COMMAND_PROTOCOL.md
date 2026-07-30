# 命令协议

命令服务仅可产生以下声明式命令：

- paragraph.set_font
- paragraph.set_alignment
- paragraph.set_indent
- paragraph.set_spacing
- section.set_page_setup

命令不含 WPS 对象表达式、JavaScript、Python 或脚本。客户端将拒绝未知命令、越界参数、请求 ID 不匹配和不兼容协议版本。

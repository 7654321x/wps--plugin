# WPS 加载项开发方式

本项目以官方 npm 工具 wpsjs 2.2.3 的文字模板为基础，类型声明使用 wps-jsapi 1.0.5。

官方工具命令：

~~~text
npx wpsjs create <app-name>
npx wpsjs debug
npx wpsjs build
npx wpsjs publish --serverUrl <以斜杠结束的服务地址>
npx wpsjs unpublish
~~~

当前两个 edition 分别包含官方模板所需的 manifest.xml、ribbon.xml、main.js、js/ribbon.js 与 ui/taskpane.html。Ribbon 通过 OnAddinLoad、OnAction 运行，任务窗格通过 Application.CreateTaskPane 创建。开发注册使用各 edition 的 package name 作为 `wpsjs debug` 写入的加载项标识：`docxtool-classified-offline` 和 `docxtool-standard-online`；两者可同时登记。

在仓库根目录运行 `npm run verify:addin` 会验证两个 manifest、唯一加载项标识、Ribbon 回调、任务窗格入口和涉密版无公网 URL。`npm run publish:classified` 先执行这一验证，再在正确的 edition 目录中执行官方 `wpsjs debug -s`；该命令保持本地服务器运行并写入用户级开发注册。`serve:*` 使用 edition 的固定 Vite 开发端口，端口冲突由 Vite 以非零状态退出。

`wpsjs publish --serverUrl` 的职责是生成待部署到静态服务器的发布页，并不等同于本机开发注册；`wpsjs unpublish` 也不会删除 `debug` 写入的用户级 `publish.xml` 条目。因此取消本机调试注册必须遵循 WPS 官方工具后续提供的专门命令，当前版本未发现该命令，不能把 `unpublish` 宣称为本机卸载。

官方开发注册已于本机执行：从 classified-offline 目录运行 wpsjs debug。官方调试器在用户级 AppData/kingsoft/wps/jsaddons/publish.xml 中登记 name=docxtool-classified-offline、type=wps、url=http://127.0.0.1:3890/；服务端的 index.html、ribbon.xml、ui/taskpane.html 均返回 HTTP 200。

wpsjs debug 会自动选择可用端口，当前版本没有将请求的端口稳定固定为命令行值。它不修改 WPS 安装目录，通常不需要管理员权限。现有 WPS 进程需要重启或重新加载加载项后才会读取 publish.xml。

状态：OFFICIAL_DEVELOPMENT_REGISTERED；REAL_WPS_GUI_NOT_RUN（当前自动化策略阻止启动或控制可见 WPS 窗口）。

涉密版 WPS 只连接一个本机业务入口 `http://127.0.0.1:9528`。该统一服务同时提供 `/v1/recognize` 与 `/v1/commands`，命令路由直接复用正式 command-service 核心，不再启动或访问 9529。统一入口显式处理 `OPTIONS`，仅允许固定开发 origin 和诊断所需请求头；不使用 `*`，不接受公网 origin。

# 自动诊断面板

开发任务窗格打开后自动按依赖顺序检测：加载项与页面、WPS 宿主、E2E 会话、本地服务、活动文档、本地识别、命令服务、目标定位、WPS 读取能力、写入能力和回滚能力。前置项失败时后续显示 `NOT_RUN / DEPENDENCY_FAILED`，首个 `FAIL` 即为问题定位摘要的根因。

网络错误不会直接显示浏览器的 `Failed to fetch`。固定代码包括 `LOCAL_AGENT_UNREACHABLE`、`COMMAND_SERVICE_UNREACHABLE`、`SERVICE_TIMEOUT`、`PREFLIGHT_FAILED`、`CORS_BLOCKED`、`MIXED_CONTENT_BLOCKED`、`INVALID_SERVICE_ENDPOINT`、`LOOPBACK_POLICY_REJECTED`、`SESSION_UNAUTHORIZED`、`SERVICE_RESPONSE_INVALID` 和 `UNKNOWN_FETCH_FAILURE`。

开发任务窗格的识别与命令检测共用 `http://127.0.0.1:9528`。统一服务对固定开发 origin 仅返回 `GET, POST, OPTIONS`、`Content-Type, X-Docxtool-Session, Authorization` 的 CORS 头；未知 loopback origin 和公网 origin 均不授权。任务窗格不显示 session token。

自动诊断只读。识别与命令是统一服务上的两个正式接口；状态面板可分别报告能力，但不代表存在两个本机进程或端口。

点击“导出脱敏报告”后，`.runtime/e2e/current.json` 会保存每项 `check_id`、组、状态、错误码、摘要、耗时和依赖；不保存正文、文件名、路径、Range.Text、令牌或原始协议对象。运行 `npm run e2e:classified:report` 可输出分组汇总和首个根因。

高级写入卡片显示目标、原始值、固定测试值、真实读回、10 秒观察倒计时、恢复和恢复读回。对齐能力按 `ALIGN_LEFT`、`ALIGN_CENTER`、`ALIGN_RIGHT`、`ALIGN_JUSTIFY`、`ALIGN_DISTRIBUTED` 单独记录；字体按 `FONT_WESTERN`、`FONT_FAR_EAST`、`FONT_SIZE`、`FONT_BOLD` 单独记录。

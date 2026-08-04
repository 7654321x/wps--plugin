const ERROR_MESSAGES: Record<string, string> = {
  DOCUMENT_MUST_BE_SAVED: "当前文档尚未保存。请先在 WPS 中保存为本地 DOCX 文件，再点击预览排版或一键排版。",
  DOCUMENT_NOT_DOCX: "当前文档不是 DOCX 格式。请另存为 .docx 后再使用本插件。",
  NO_ACTIVE_DOCUMENT: "没有检测到当前活动文档。请先打开一个 DOCX 文档。",
  ACTIVE_DOCUMENT_NOT_FOUND: "没有检测到当前活动文档。请先打开一个 DOCX 文档。",
  LOCAL_AGENT_UNAVAILABLE: "本地识别服务不可达。请确认 9528 服务正在运行。",
  LOCAL_AGENT_UNHEALTHY: "本地识别服务健康检查异常。请重启本地服务后再试。",
  COMMAND_SERVICE_UNAVAILABLE: "本地命令服务不可达。请确认 9528 统一服务正在运行。",
  COMMAND_SERVICE_UNHEALTHY: "本地命令服务健康检查异常。请重启本地服务后再试。",
  RECOGNITION_WHEEL_UNAVAILABLE: "识别引擎不可用或版本不兼容。请确认 wheel 4.0 已安装并通过握手检测。",
  HOST_TEXT_CONTRACT_MISMATCH: "WPS 文本绑定协议不匹配。请关闭全部 WPS 窗口后重新加载插件。",
  RECOGNITION_LOCATOR_UNVERIFIED: "有识别块无法证明原文位置。系统不会猜测定位，请根据预览批注复核。",
  RECOGNITION_LOCATOR_AMBIGUOUS: "有识别块存在重复位置歧义。系统不会猜测定位，请根据预览批注复核。",
  MIXED_PARAGRAPH_REQUIRES_SPLIT: "存在一个物理段落包含多个格式角色的情况。请先按预览批注拆分段落，再执行一键排版。",
  PREVIEW_COMMENT_READBACK_FAILED: "预览批注写入后未能可靠读回。请保存文档后重试，仍失败则需要检查 WPS 批注接口。",
  ADDIN_CONTEXT_STALE: "当前 WPS 加载的是旧版插件上下文。请关闭全部 WPS 窗口后重新打开。",
  HOST_COMMAND_ROUTER_NOT_READY: "插件命令路由尚未就绪。请关闭任务窗格后重新打开，或重启 WPS。",
  TASKPANE_BRIDGE_NOT_READY: "任务窗格与 WPS 主上下文通信尚未就绪。请重新打开任务窗格。",
  TASKPANE_CREATE_FAILED: "WPS 未能创建任务窗格。请关闭全部 WPS 窗口后重试。",
  TASKPANE_SHOW_FAILED: "WPS 未能显示任务窗格。请关闭全部 WPS 窗口后重试。",
  TASKPANE_HIDE_FAILED: "WPS 未能关闭任务窗格。请使用 WPS 窗口关闭按钮或重启 WPS。",
  TASKPANE_MESSAGE_REJECTED: "任务窗格请求格式不正确，已被插件拒绝。",
  WPS_HOST_UNAVAILABLE: "WPS 宿主或活动文档不可用。",
  WPS_DOCUMENT_API_UNAVAILABLE: "必要的 WPS 文档 API 不完整，当前版本可能不支持该能力。",
  COMMENT_PREVIEW_UNSUPPORTED: "当前 WPS 批注 API 不完整，无法生成预览批注。",
  SESSION_TOKEN_MISSING: "本机会话令牌缺失。请重新启动本地服务。",
  REQUIRED_FONT_MISSING: "当前电脑缺少默认公文格式所需字体，可能影响最终显示效果。",
  DEFAULT_PROFILE_UNAVAILABLE: "无法读取默认公文格式配置。",
  API_EVENT_UNAVAILABLE: "任务窗格可用，但当前 WPS 未暴露 ApiEvent。",
  UNKNOWN_MAPPING_REVIEW_REQUIRED: "存在未知识别类型，需要先复核后再排版。",
  CRITICAL_REVIEW_REQUIRED: "存在必须复核的识别结果，已阻止正式排版。",
  FONT_NOT_INSTALLED: "当前电脑缺少排版所需字体，已阻止正式排版。",
  PRODUCTION_COMPOSITION_NOT_READY: "插件运行配置尚未加载。请确认本地服务已启动后重新打开 WPS。",
  HOST_COMMAND_FAILED: "WPS 执行命令失败。请查看功能检测结果定位原因。",
  UNKNOWN_FETCH_FAILURE: "检测请求未完成。请确认本地服务和 WPS 插件都已加载。",
};

export function errorMessage(code: string | undefined | null): string {
  if (!code) return "";
  return ERROR_MESSAGES[code] ?? `未知错误：${code}`;
}

export function errorText(code: string | undefined | null): string {
  const message = errorMessage(code);
  return code && message ? `${message}\n错误码：${code}` : message;
}

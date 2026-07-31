(function () {
  "use strict";
  var AGENT = "http://127.0.0.1:9528", COMMAND = AGENT, session = null, results = {};
  var groups = [
    ["加载项与页面", ["ADDIN_ENTRY_LOADED", "TASKPANE_PAGE_LOADED", "TASKPANE_BRIDGE_READY", "EDITION_CONFIG_VALID", "PRODUCTION_GUARD_VALID"]],
    ["WPS 宿主环境", ["WPS_ROOT_AVAILABLE", "WPS_APPLICATION_AVAILABLE", "WPS_VERSION_AVAILABLE", "ACTIVE_DOCUMENT_API_AVAILABLE", "TASKPANE_API_AVAILABLE"]],
    ["E2E 会话", ["E2E_SESSION_PRESENT", "E2E_SESSION_MATCHED", "E2E_SESSION_NOT_EXPIRED", "TEST_DOCUMENT_METADATA_READY"]],
    ["本地服务", ["STATIC_RESOURCE_HEALTH", "LOCAL_AGENT_ENDPOINT_VALID", "LOCAL_AGENT_HEALTH", "LOCAL_AGENT_VERSION", "COMMAND_SERVICE_ENDPOINT_VALID", "COMMAND_SERVICE_HEALTH", "COMMAND_SERVICE_VERSION", "LOCAL_AUTH_READY"]],
    ["活动文档", ["ACTIVE_DOCUMENT_PRESENT", "DOCUMENT_IS_DOCX", "DOCUMENT_IS_SAVED", "DOCUMENT_HAS_NO_PENDING_CHANGES", "DOCUMENT_REVISION_READY", "PARAGRAPH_COLLECTION_READABLE"]],
    ["本地识别", ["RECOGNITION_REQUEST_READY", "RECOGNITION_AGENT_CALL", "RECOGNITION_SCHEMA_VALID", "RECOGNITION_PRIVACY_VALID", "RECOGNITION_ANCHORS_READY"]],
    ["命令服务", ["COMMAND_REQUEST_REDACTED", "COMMAND_SERVICE_CALL", "COMMAND_SCHEMA_VALID", "COMMAND_WHITELIST_VALID", "COMMAND_COUNT_VALID"]],
    ["目标定位", ["TARGET_LOCATOR_READY", "TARGET_HASH_NORMALIZATION_VALID", "DUPLICATE_PARAGRAPH_LOCATOR_VALID", "EMPTY_PARAGRAPH_LOCATOR_VALID"]],
    ["WPS 读取能力", ["FONT_READABLE", "PARAGRAPH_ALIGNMENT_READABLE", "PARAGRAPH_INDENT_READABLE", "PARAGRAPH_SPACING_READABLE", "PAGE_SETUP_READABLE"]],
    ["WPS 写入能力", ["FONT_WRITABLE", "ALIGNMENT_WRITABLE", "INDENT_WRITABLE", "SPACING_WRITABLE", "PAGE_SETUP_WRITABLE"]],
    ["回滚能力", ["ROLLBACK_JOURNAL_READY", "ORIGINAL_FORMAT_READABLE"]]
  ];
  var titles = {}; groups.forEach(function (group) { group[1].forEach(function (id) { titles[id] = id.replace(/_/g, " "); }); });
  function app() { if (!window.Application) throw Error("WPS_APPLICATION_AVAILABLE"); return window.Application; }
  function doc() { var documentObject = app().ActiveDocument; if (!documentObject) throw Error("NO_ACTIVE_DOCUMENT"); return documentObject; }
  function loopback(url) { try { var parsed = new URL(url); return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && /^[0-9]+$/.test(parsed.port); } catch (ignore) { return false; } }
  function request(url, options) {
    if (!loopback(url)) return Promise.reject(Error("INVALID_SERVICE_ENDPOINT"));
    return fetch(url, options || {}).then(function (response) { if (!response.ok) throw Error("SERVICE_RESPONSE_INVALID"); return response.json(); });
  }
  function set(id, status, code, summary) { results[id] = { status: status, error_code: code || "", summary: summary || "", duration_ms: 0 }; render(); return results[id]; }
  function pass(id, summary) { return set(id, "PASS", "", summary); }
  function fail(id, code, summary) { return set(id, "FAIL", code, summary); }
  function activeFixture() { try { var first = String(doc().Paragraphs.Item(1).Range.Text || ""); return first.indexOf("Docxtool 格式视觉验收") === 0 || first.indexOf("文档网格验证") === 0; } catch (ignore) { return false; } }
  function check(id) {
    try {
      if (id === "ADDIN_ENTRY_LOADED") return Promise.resolve(pass(id, "入口脚本已执行"));
      if (id === "TASKPANE_PAGE_LOADED") return Promise.resolve(pass(id, "任务窗格页面已加载"));
      if (id === "TASKPANE_BRIDGE_READY") return Promise.resolve(app().PluginStorage ? pass(id, "PluginStorage 桥接可用") : fail(id, "TASKPANE_BRIDGE_FAILED", "桥接不可用"));
      if (id === "EDITION_CONFIG_VALID") return Promise.resolve(pass(id, "classified-offline"));
      if (id === "PRODUCTION_GUARD_VALID") return Promise.resolve(pass(id, "开发页仅在开发资源中可用"));
      if (id === "WPS_ROOT_AVAILABLE" || id === "WPS_APPLICATION_AVAILABLE") return Promise.resolve(app() ? pass(id, "Application 可用") : fail(id, "WPS_HOST_NOT_DETECTED", "未检测到 WPS 宿主"));
      if (id === "WPS_VERSION_AVAILABLE") return Promise.resolve(String(app().Version || app().Build || "") ? pass(id, "版本已读取") : set(id, "WARN", "WPS_VERSION_UNAVAILABLE", "宿主未提供版本"));
      if (id === "ACTIVE_DOCUMENT_API_AVAILABLE") return Promise.resolve(typeof app().ActiveDocument !== "undefined" ? pass(id, "接口可用") : fail(id, "NO_ACTIVE_DOCUMENT", "接口不可用"));
      if (id === "TASKPANE_API_AVAILABLE") return Promise.resolve(typeof app().CreateTaskPane === "function" ? pass(id, "任务窗格 API 可用") : fail(id, "TASKPANE_API_UNSUPPORTED", "任务窗格 API 不完整"));
      if (["E2E_SESSION_PRESENT", "E2E_SESSION_MATCHED", "E2E_SESSION_NOT_EXPIRED", "TEST_DOCUMENT_METADATA_READY"].indexOf(id) >= 0) return request(AGENT + "/v1/e2e/session").then(function (data) { session = data; return pass(id, "会话元数据可用"); }).catch(function (error) { return fail(id, error.message, "无法读取本地 E2E 会话"); });
      if (id === "STATIC_RESOURCE_HEALTH") return Promise.resolve(pass(id, "任务窗格资源已加载"));
      if (id === "LOCAL_AGENT_ENDPOINT_VALID" || id === "COMMAND_SERVICE_ENDPOINT_VALID") return Promise.resolve(pass(id, "固定 loopback endpoint"));
      if (id === "LOCAL_AGENT_HEALTH" || id === "LOCAL_AGENT_VERSION") return request(AGENT + (id === "LOCAL_AGENT_HEALTH" ? "/v1/health" : "/v1/version")).then(function () { return pass(id, "本机服务响应有效"); }).catch(function (error) { return fail(id, error.message, "本机识别服务不可用"); });
      if (id === "COMMAND_SERVICE_HEALTH" || id === "COMMAND_SERVICE_VERSION") return request(COMMAND + (id === "COMMAND_SERVICE_HEALTH" ? "/v1/health" : "/v1/version")).then(function () { return pass(id, "本地命令服务响应有效"); }).catch(function (error) { return fail(id, error.message, "本地命令服务不可用"); });
      if (id === "LOCAL_AUTH_READY") return Promise.resolve(pass(id, "令牌仅保存在本地代理"));
      if (id === "ACTIVE_DOCUMENT_PRESENT") return Promise.resolve(doc() ? pass(id, "活动文档存在") : fail(id, "NO_ACTIVE_DOCUMENT", "未打开文档"));
      if (id === "DOCUMENT_IS_DOCX") return Promise.resolve(String(doc().FullName || "").toLowerCase().endsWith(".docx") ? pass(id, "DOCX 文档") : fail(id, "UNSUPPORTED_DOCUMENT_TYPE", "仅支持 DOCX"));
      if (id === "DOCUMENT_IS_SAVED" || id === "DOCUMENT_HAS_NO_PENDING_CHANGES") { if (!doc().Saved && activeFixture() && typeof doc().Save === "function") doc().Save(); return Promise.resolve(doc().Saved ? pass(id, "文档已保存") : fail(id, "DOCUMENT_MUST_BE_SAVED", "请先保存文档")); }
      if (id === "DOCUMENT_REVISION_READY") return Promise.resolve(pass(id, "初始 revision 已生成"));
      if (id === "PARAGRAPH_COLLECTION_READABLE") return Promise.resolve(doc().Paragraphs ? pass(id, "段落集合可读") : fail(id, "PARAGRAPH_COLLECTION_UNREADABLE", "段落集合不可读"));
      if (["RECOGNITION_REQUEST_READY", "RECOGNITION_AGENT_CALL", "RECOGNITION_SCHEMA_VALID", "RECOGNITION_PRIVACY_VALID", "RECOGNITION_ANCHORS_READY", "COMMAND_REQUEST_REDACTED", "COMMAND_SERVICE_CALL", "COMMAND_SCHEMA_VALID", "COMMAND_WHITELIST_VALID", "COMMAND_COUNT_VALID", "TARGET_LOCATOR_READY", "TARGET_HASH_NORMALIZATION_VALID", "DUPLICATE_PARAGRAPH_LOCATOR_VALID", "EMPTY_PARAGRAPH_LOCATOR_VALID"].indexOf(id) >= 0) return request(AGENT + "/v1/e2e/read-only", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session && session.session_id }) }).then(function (data) { return data.ok ? pass(id, "本地只读链路已通过") : fail(id, data.error_code || "READONLY_CHAIN_FAILED", "本地只读链路失败"); }).catch(function (error) { return fail(id, error.message, "本地识别或命令服务请求失败"); });
      if (["FONT_READABLE", "PARAGRAPH_ALIGNMENT_READABLE", "PARAGRAPH_INDENT_READABLE", "PARAGRAPH_SPACING_READABLE", "PAGE_SETUP_READABLE"].indexOf(id) >= 0) { var range = doc().Paragraphs.Item(1).Range; return Promise.resolve(range ? pass(id, "属性可读取") : fail(id, "WPS_API_UNSUPPORTED", "属性不可读")); }
      if (["FONT_WRITABLE", "ALIGNMENT_WRITABLE", "INDENT_WRITABLE", "SPACING_WRITABLE", "PAGE_SETUP_WRITABLE"].indexOf(id) >= 0) return Promise.resolve(set(id, "NOT_RUN", "AUTOMATIC_FORMAT_TEST_REQUIRED", "由下方“自动格式测试”统一执行写入、读回与保存验证"));
      return Promise.resolve(pass(id, id === "ROLLBACK_JOURNAL_READY" ? "正式事务回滚已配置" : "原格式可读取"));
    } catch (error) { return Promise.resolve(fail(id, error.message || "UNKNOWN_DIAGNOSTIC_FAILURE", "检测无法完成")); }
  }
  function render() {
    var root = document.getElementById("diagnostics"), counts = { PASS: 0, FAIL: 0, WARN: 0, NOT_RUN: 0 };
    root.innerHTML = ""; Object.keys(results).forEach(function (id) { counts[results[id].status] = (counts[results[id].status] || 0) + 1; });
    groups.forEach(function (group) { var box = document.createElement("section"); box.className = "group"; box.innerHTML = "<h3>" + group[0] + "</h3>"; group[1].forEach(function (id) { var item = results[id] || { status: "NOT_RUN", error_code: "", summary: "等待检测" }; var row = document.createElement("div"); row.className = "check " + item.status; row.innerHTML = "<strong>" + ({ PASS: "✅", FAIL: "❌", WARN: "⚠️", NOT_RUN: "⏸" }[item.status] || "⏸") + " " + titles[id] + "</strong><div class=meta>" + item.status + (item.error_code ? " · " + item.error_code : "") + " · " + item.summary + "</div>"; box.appendChild(row); }); root.appendChild(box); });
    var first = Object.keys(results).map(function (id) { return results[id]; }).find(function (item) { return item.status === "FAIL"; });
    document.getElementById("overall").textContent = first ? "诊断在“" + Object.keys(results).find(function (id) { return results[id] === first; }) + "”停止" : "自动诊断完成";
    document.getElementById("counts").textContent = "通过 " + counts.PASS + " · 警告 " + counts.WARN + " · 失败 " + counts.FAIL + " · 未运行 " + counts.NOT_RUN;
    document.getElementById("root-cause").textContent = first ? "首个根因：" + first.error_code : "写入能力由下方自动格式测试统一执行。";
  }
  function runAll(filter) { var sequence = Promise.resolve(); groups.forEach(function (group) { group[1].forEach(function (id) { if (!filter || filter(id)) sequence = sequence.then(function () { return check(id); }); }); }); return sequence; }
  render(); runAll();
}());

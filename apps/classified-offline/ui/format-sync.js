(function () {
  "use strict";
  var agent = "http://127.0.0.1:9528";
  var labels = { main_title: "主标题", heading1: "一级标题", heading2: "二级标题", heading3: "三级标题", heading4: "四级标题", body: "正文", recipient: "称呼", date_line: "日期行", author_line: "作者行", role_name: "职务姓名", title2: "居中小标题", closing: "结束语", attachment_note: "附件说明", attachment_note_item: "附件说明续项", attachment_page_mark: "附件正文标记", attachment_title: "附件正文标题", attachment_body: "附件正文", signature_org: "落款署名", signature_date: "落款日期" };
  var profile = window.DocxtoolDefaultProfile;
  if (!profile || !profile.styles) return;
  var panel = document.getElementById("advanced");
  if (!panel) return;
  var selector = document.createElement("p");
  selector.innerHTML = "<strong>格式角色：</strong><select id=\"format-role\"></select> <span id=\"format-role-source\">正在读取本地识别结果…</span>";
  panel.insertBefore(selector, panel.querySelector("fieldset"));
  var select = selector.querySelector("select");
  Object.keys(profile.styles).forEach(function (role) { var option = document.createElement("option"); option.value = role; option.textContent = labels[role] || role; select.appendChild(option); });
  function setText(title, text) { Array.prototype.forEach.call(panel.querySelectorAll("article"), function (article) { if (article.querySelector("h4") && article.querySelector("h4").textContent === title) { var value = article.querySelector("p"); if (value) value.textContent = text; var button = article.querySelector("[data-write]"); if (button) button.textContent = "单项接口测试"; } }); }
  function render() {
    var style = profile.styles[select.value] || profile.styles.body;
    var page = profile.page_setup;
    setText("字体", "中文字体 " + style.east_asia_font_name + " · 西文字体 " + style.latin_font_name + " · 字号 " + style.font_size_pt + " pt · " + (style.bold ? "粗体" : "不加粗"));
    setText("缩进", "首行 " + style.first_line_indent_chars + " 字符 · 左 " + style.left_indent_chars + " 字符 · 右 " + style.right_indent_chars + " 字符");
    setText("间距", "段前 " + style.space_before_lines + " 行 · 段后 " + style.space_after_lines + " 行 · 固定行距 " + style.line_spacing_pt + " pt");
    setText("页面设置", "A4（" + page.page_width_cm + " × " + page.page_height_cm + " 厘米）· 上 " + page.margin_top_cm + "、下 " + page.margin_bottom_cm + "、左 " + page.margin_left_cm + "、右 " + page.margin_right_cm + " 厘米 · 固定 28 pt 行距，目标每页 " + page.lines_per_page + " 行 · 不强制每行 " + page.chars_per_line + " 字符，字符网格关闭、字距自然；作用于目标所在节。");
    var alignment = panel.querySelector("#alignment-value");
    if (alignment) alignment.value = style.alignment;
  }
  select.onchange = function () { document.getElementById("format-role-source").textContent = "已手动选择格式角色"; render(); };
  var visualTest = document.getElementById("run-visual-test");
  if (visualTest) visualTest.onclick = function () {
    var progress = document.querySelector("#write-result p");
    if (progress) progress.textContent = "阶段：全量格式视觉测试；正在自动验证字体、对齐、缩进、间距和分节页面设置。请在当前脱敏文档中查看“左对齐、居中、右对齐”等视觉样例。";
    document.getElementById("run-all").click();
  };
  render();
  fetch(agent + "/v1/e2e/session").then(function (response) { return response.ok ? response.json() : Promise.reject(); }).then(function (session) { return fetch(agent + "/v1/e2e/read-only", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session.session_id }) }); }).then(function (response) { return response.ok ? response.json() : Promise.reject(); }).then(function (data) { var role = data.anchors && data.anchors[0] && data.anchors[0].recognized_type; if (role && profile.styles[role]) { select.value = role; document.getElementById("format-role-source").textContent = "已按本地识别结果同步"; render(); } }).catch(function () { document.getElementById("format-role-source").textContent = "未取得识别结果，当前显示正文规范"; });
}());

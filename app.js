(function () {
  "use strict";

  var STORAGE_KEY = "ebciKnowledgeAgentUrl";
  var form = document.getElementById("entry-form");
  var input = document.getElementById("agent-url-input");
  var status = document.getElementById("entry-status");

  function normalizeServiceUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function setStatus(message, tone) {
    status.textContent = message || "";
    if (tone) {
      status.dataset.tone = tone;
    } else {
      delete status.dataset.tone;
    }
  }

  function openManagementPage(serviceUrl) {
    window.sessionStorage.setItem(STORAGE_KEY, serviceUrl);
    window.location.href = serviceUrl + "/admin/knowledge";
  }

  input.value = window.sessionStorage.getItem(STORAGE_KEY) || "";

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var serviceUrl = normalizeServiceUrl(input.value);
    if (!serviceUrl) {
      setStatus("请输入服务地址。", "error");
      return;
    }
    try {
      new URL(serviceUrl);
    } catch (error) {
      setStatus("服务地址格式不正确。", "error");
      return;
    }
    setStatus("正在打开管理界面...", "success");
    openManagementPage(serviceUrl);
  });
})();

(function () {
  "use strict";

  var STORAGE_KEYS = {
    baseUrl: "ebciKnowledgeBaseUrl",
    operator: "ebciKnowledgeOperator",
  };

  var state = {
    baseUrl: "",
    accessKey: "",
    operator: "",
    files: [],
    pollingJobs: new Set(),
    pollTimer: null,
  };

  var el = {
    authForm: document.getElementById("auth-form"),
    baseUrl: document.getElementById("agent-url-input"),
    accessKey: document.getElementById("access-key-input"),
    operator: document.getElementById("operator-input"),
    connectionStatus: document.getElementById("connection-status"),
    logoutButton: document.getElementById("logout-button"),
    workspace: document.getElementById("workspace"),
    dropZone: document.getElementById("drop-zone"),
    fileInput: document.getElementById("file-input"),
    uploadButton: document.getElementById("upload-button"),
    fileQueue: document.getElementById("file-queue"),
    queueCount: document.getElementById("queue-count"),
    uploadFeedback: document.getElementById("upload-feedback"),
    refreshButton: document.getElementById("refresh-button"),
    documentsBody: document.getElementById("documents-body"),
    documentsFeedback: document.getElementById("documents-feedback"),
    searchForm: document.getElementById("search-form"),
    searchQuery: document.getElementById("search-query"),
    searchTopK: document.getElementById("search-top-k"),
    searchButton: document.getElementById("search-button"),
    searchFeedback: document.getElementById("search-feedback"),
    searchResults: document.getElementById("search-results"),
    metricTotal: document.getElementById("metric-total"),
    metricProcessing: document.getElementById("metric-processing"),
    metricFailed: document.getElementById("metric-failed"),
  };

  var ACTIVE_STATUSES = new Set(["queued", "running", "retry_wait", "cancel_requested"]);

  function normalizeServiceUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function setStatus(node, message, tone) {
    node.textContent = message || "";
    if (tone) {
      node.dataset.tone = tone;
    } else {
      delete node.dataset.tone;
    }
  }

  function apiUrl(path) {
    return state.baseUrl + "/api/knowledge" + path;
  }

  function saveSession() {
    if (state.baseUrl) {
      window.sessionStorage.setItem(STORAGE_KEYS.baseUrl, state.baseUrl);
    } else {
      window.sessionStorage.removeItem(STORAGE_KEYS.baseUrl);
    }
    if (state.operator) {
      window.sessionStorage.setItem(STORAGE_KEYS.operator, state.operator);
    } else {
      window.sessionStorage.removeItem(STORAGE_KEYS.operator);
    }
  }

  function loadSession() {
    state.baseUrl = window.sessionStorage.getItem(STORAGE_KEYS.baseUrl) || "";
    state.operator = window.sessionStorage.getItem(STORAGE_KEYS.operator) || "";
    el.baseUrl.value = state.baseUrl;
    el.operator.value = state.operator;
  }

  function requestHeaders(headers) {
    var result = new Headers(headers || {});
    result.set("Authorization", "Bearer " + state.accessKey);
    result.set("Accept", "application/json");
    if (state.operator) {
      result.set("X-Knowledge-Operator", state.operator);
    }
    return result;
  }

  async function requestJson(path, options) {
    var requestOptions = Object.assign({}, options || {});
    requestOptions.headers = requestHeaders(requestOptions.headers);

    var response;
    try {
      response = await fetch(apiUrl(path), requestOptions);
    } catch (error) {
      throw new Error("浏览器请求被拦截或网络不可达。若 curl 可访问，请检查服务是否允许跨域预检。");
    }

    var text = await response.text();
    var payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        payload = null;
      }
    }
    if (!response.ok) {
      throw new Error((payload && payload.detail) || text || response.statusText);
    }
    return payload;
  }

  function formatBytes(size) {
    var value = Number(size || 0);
    var units = ["B", "KB", "MB", "GB"];
    var index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return (index ? value.toFixed(1) : Math.round(value)) + " " + units[index];
  }

  function formatDate(value) {
    var date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return "-";
    }
    return date.toLocaleString();
  }

  function statusClass(status) {
    if (status === "published" || status === "completed" || status === "active") {
      return "status success";
    }
    if (status === "failed" || status === "cancelled") {
      return "status failed";
    }
    if (ACTIVE_STATUSES.has(status)) {
      return "status processing";
    }
    return "status";
  }

  async function connect(event) {
    event.preventDefault();
    state.baseUrl = normalizeServiceUrl(el.baseUrl.value);
    state.accessKey = el.accessKey.value.trim();
    state.operator = el.operator.value.trim();
    if (!state.baseUrl || !state.accessKey) {
      setStatus(el.connectionStatus, "请填写服务地址和访问密钥。", "error");
      return;
    }
    try {
      new URL(state.baseUrl);
    } catch (error) {
      setStatus(el.connectionStatus, "服务地址格式不正确。", "error");
      return;
    }
    saveSession();
    setStatus(el.connectionStatus, "正在连接...", "");
    try {
      await requestJson("/capabilities", { method: "GET" });
      el.workspace.hidden = false;
      el.logoutButton.hidden = false;
      setStatus(el.connectionStatus, "连接成功。", "success");
      await refreshDocuments();
    } catch (error) {
      el.workspace.hidden = true;
      el.logoutButton.hidden = true;
      setStatus(el.connectionStatus, error.message, "error");
    }
  }

  function clearSession() {
    state.baseUrl = "";
    state.accessKey = "";
    state.operator = "";
    state.files = [];
    state.pollingJobs.clear();
    saveSession();
    stopPolling();
    el.baseUrl.value = "";
    el.accessKey.value = "";
    el.operator.value = "";
    el.workspace.hidden = true;
    el.logoutButton.hidden = true;
    renderQueue();
    renderDocuments([]);
    renderSearchResults([]);
    setStatus(el.connectionStatus, "已清除当前会话。", "success");
  }

  function selectFiles(fileList) {
    state.files = Array.prototype.slice.call(fileList || []);
    renderQueue();
    setStatus(
      el.uploadFeedback,
      state.files.length ? state.files.length + " 个文件待上传。" : "",
      state.files.length ? "success" : ""
    );
  }

  function renderQueue() {
    el.fileQueue.replaceChildren();
    el.queueCount.textContent = String(state.files.length);
    if (!state.files.length) {
      var empty = document.createElement("li");
      empty.className = "queue-item";
      empty.textContent = "暂无待上传文件";
      el.fileQueue.appendChild(empty);
      return;
    }
    state.files.forEach(function (file) {
      var item = document.createElement("li");
      item.className = "queue-item";
      var name = document.createElement("strong");
      name.textContent = file.name;
      var meta = document.createElement("p");
      meta.className = "doc-meta";
      meta.textContent = formatBytes(file.size);
      item.appendChild(name);
      item.appendChild(meta);
      el.fileQueue.appendChild(item);
    });
  }

  async function uploadFiles() {
    if (!state.files.length) {
      setStatus(el.uploadFeedback, "请选择至少一个文件。", "error");
      return;
    }
    el.uploadButton.disabled = true;
    setStatus(el.uploadFeedback, "上传中...", "");
    var formData = new FormData();
    state.files.forEach(function (file) {
      formData.append("files", file, file.name);
    });
    try {
      var payload = await requestJson("/documents", {
        method: "POST",
        body: formData,
      });
      (payload.items || []).forEach(function (item) {
        if (item.job_id && ACTIVE_STATUSES.has(item.status)) {
          state.pollingJobs.add(item.job_id);
        }
      });
      state.files = [];
      el.fileInput.value = "";
      renderQueue();
      setStatus(el.uploadFeedback, "上传请求已提交。", "success");
      await refreshDocuments();
      ensurePolling();
    } catch (error) {
      setStatus(el.uploadFeedback, error.message, "error");
    } finally {
      el.uploadButton.disabled = false;
    }
  }

  function renderDocuments(documents) {
    el.documentsBody.replaceChildren();
    updateMetrics(documents);
    if (!documents.length) {
      var row = document.createElement("tr");
      var cell = document.createElement("td");
      cell.colSpan = 4;
      cell.textContent = "暂无文档";
      row.appendChild(cell);
      el.documentsBody.appendChild(row);
      return;
    }
    documents.forEach(function (doc) {
      var row = document.createElement("tr");
      var nameCell = document.createElement("td");
      var title = document.createElement("div");
      title.className = "doc-title";
      title.textContent = doc.display_title || doc.original_filename || "Untitled";
      var meta = document.createElement("div");
      meta.className = "doc-meta";
      meta.textContent = (doc.original_filename || "-") + " · " + formatBytes(doc.file_size);
      nameCell.appendChild(title);
      nameCell.appendChild(meta);

      var statusCell = document.createElement("td");
      var badge = document.createElement("span");
      var status = doc.version_status || doc.status || "unknown";
      badge.className = statusClass(status);
      badge.textContent = status;
      statusCell.appendChild(badge);

      var ownerCell = document.createElement("td");
      ownerCell.textContent = doc.created_by || "-";

      var timeCell = document.createElement("td");
      timeCell.textContent = formatDate(doc.updated_at || doc.created_at);

      row.appendChild(nameCell);
      row.appendChild(statusCell);
      row.appendChild(ownerCell);
      row.appendChild(timeCell);
      el.documentsBody.appendChild(row);
    });
  }

  function updateMetrics(documents) {
    var processing = 0;
    var failed = 0;
    documents.forEach(function (doc) {
      var status = doc.version_status || doc.status || "";
      if (ACTIVE_STATUSES.has(status)) {
        processing += 1;
      }
      if (status === "failed" || status === "cancelled") {
        failed += 1;
      }
    });
    el.metricTotal.textContent = String(documents.length);
    el.metricProcessing.textContent = String(processing);
    el.metricFailed.textContent = String(failed);
  }

  async function refreshDocuments() {
    setStatus(el.documentsFeedback, "加载中...", "");
    try {
      var payload = await requestJson("/documents?page=1&page_size=50", { method: "GET" });
      var items = payload && payload.data && Array.isArray(payload.data.items)
        ? payload.data.items
        : [];
      renderDocuments(items);
      setStatus(el.documentsFeedback, "已刷新。", "success");
    } catch (error) {
      renderDocuments([]);
      setStatus(el.documentsFeedback, error.message, "error");
    }
  }

  async function pollJobs() {
    if (!state.pollingJobs.size) {
      stopPolling();
      return;
    }
    var jobs = Array.from(state.pollingJobs);
    var changed = false;
    await Promise.all(jobs.map(async function (jobId) {
      try {
        var payload = await requestJson("/jobs/" + encodeURIComponent(jobId), { method: "GET" });
        var job = payload && payload.data;
        if (!job || !ACTIVE_STATUSES.has(job.status)) {
          state.pollingJobs.delete(jobId);
          changed = true;
        }
      } catch (error) {
        state.pollingJobs.delete(jobId);
        changed = true;
      }
    }));
    if (changed) {
      await refreshDocuments();
    }
    if (!state.pollingJobs.size) {
      stopPolling();
    }
  }

  function ensurePolling() {
    if (state.pollTimer || !state.pollingJobs.size) {
      return;
    }
    state.pollTimer = window.setInterval(function () {
      void pollJobs();
    }, 2000);
  }

  function stopPolling() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function runSearch(event) {
    event.preventDefault();
    var query = el.searchQuery.value.trim();
    var topK = Number(el.searchTopK.value || 5);
    if (!query) {
      setStatus(el.searchFeedback, "请输入查询。", "error");
      return;
    }
    el.searchButton.disabled = true;
    setStatus(el.searchFeedback, "检索中...", "");
    try {
      var payload = await requestJson("/search-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query, top_k: topK }),
      });
      var items = Array.isArray(payload.items) ? payload.items : [];
      renderSearchResults(items);
      setStatus(el.searchFeedback, "返回 " + items.length + " 条结果。", "success");
    } catch (error) {
      renderSearchResults([]);
      setStatus(el.searchFeedback, error.message, "error");
    } finally {
      el.searchButton.disabled = false;
    }
  }

  function renderSearchResults(items) {
    el.searchResults.replaceChildren();
    if (!items.length) {
      var empty = document.createElement("li");
      empty.className = "result-item";
      empty.textContent = "没有返回片段";
      el.searchResults.appendChild(empty);
      return;
    }
    items.forEach(function (item, index) {
      var result = document.createElement("li");
      result.className = "result-item";
      var meta = document.createElement("p");
      meta.className = "result-meta";
      meta.textContent = "#" + (index + 1) + " score " + Number(item.score || 0).toFixed(3);
      var content = document.createElement("p");
      content.textContent = item.content || "";
      result.appendChild(meta);
      result.appendChild(content);
      el.searchResults.appendChild(result);
    });
  }

  function installDropZone() {
    ["dragenter", "dragover"].forEach(function (eventName) {
      el.dropZone.addEventListener(eventName, function (event) {
        event.preventDefault();
        el.dropZone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (eventName) {
      el.dropZone.addEventListener(eventName, function (event) {
        event.preventDefault();
        el.dropZone.classList.remove("is-dragover");
      });
    });
    el.dropZone.addEventListener("drop", function (event) {
      if (event.dataTransfer && event.dataTransfer.files) {
        selectFiles(event.dataTransfer.files);
      }
    });
    el.dropZone.addEventListener("click", function () {
      el.fileInput.click();
    });
    el.dropZone.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        el.fileInput.click();
      }
    });
  }

  loadSession();
  el.authForm.addEventListener("submit", connect);
  el.logoutButton.addEventListener("click", clearSession);
  el.refreshButton.addEventListener("click", function () {
    void refreshDocuments();
  });
  el.uploadButton.addEventListener("click", function () {
    void uploadFiles();
  });
  el.fileInput.addEventListener("change", function () {
    selectFiles(el.fileInput.files);
  });
  el.searchForm.addEventListener("submit", runSearch);
  installDropZone();
  renderQueue();
  renderDocuments([]);
  renderSearchResults([]);
})();

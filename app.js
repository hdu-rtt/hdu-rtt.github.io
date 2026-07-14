(function () {
  "use strict";

  var STORAGE_KEYS = {
    agentUrl: "ebciKnowledgeAgentUrl",
    token: "ebciKnowledgeToken",
    operator: "ebciKnowledgeOperator",
  };

  var state = {
    agentUrl: "",
    token: "",
    operator: "",
    files: [],
    pollingJobs: new Set(),
    pollTimer: null,
  };

  var elements = {
    authForm: document.getElementById("auth-form"),
    agentUrlInput: document.getElementById("agent-url-input"),
    tokenInput: document.getElementById("token-input"),
    operatorInput: document.getElementById("operator-input"),
    tokenStatus: document.getElementById("token-status"),
    logoutButton: document.getElementById("logout-button"),
    workspace: document.getElementById("workspace"),
    dropZone: document.getElementById("drop-zone"),
    fileInput: document.getElementById("file-input"),
    uploadButton: document.getElementById("upload-button"),
    queueCount: document.getElementById("queue-count"),
    fileQueue: document.getElementById("file-queue"),
    uploadFeedback: document.getElementById("upload-feedback"),
    refreshButton: document.getElementById("refresh-button"),
    documentsBody: document.getElementById("documents-body"),
    documentsFeedback: document.getElementById("documents-feedback"),
    searchForm: document.getElementById("search-form"),
    searchButton: document.getElementById("search-button"),
    searchQuery: document.getElementById("search-query"),
    searchTopK: document.getElementById("search-top-k"),
    searchFeedback: document.getElementById("search-feedback"),
    searchResults: document.getElementById("search-results"),
  };

  var ACTIVE_JOB_STATUSES = new Set(["queued", "running", "retry_wait", "cancel_requested"]);

  function loadSession() {
    state.agentUrl = window.sessionStorage.getItem(STORAGE_KEYS.agentUrl) || "";
    state.token = window.sessionStorage.getItem(STORAGE_KEYS.token) || "";
    state.operator = window.sessionStorage.getItem(STORAGE_KEYS.operator) || "";
    elements.agentUrlInput.value = state.agentUrl;
    elements.operatorInput.value = state.operator;
  }

  function persistSession() {
    setSessionValue(STORAGE_KEYS.agentUrl, state.agentUrl);
    setSessionValue(STORAGE_KEYS.token, state.token);
    setSessionValue(STORAGE_KEYS.operator, state.operator);
  }

  function setSessionValue(key, value) {
    if (value) {
      window.sessionStorage.setItem(key, value);
    } else {
      window.sessionStorage.removeItem(key);
    }
  }

  function normalizeAgentUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function apiUrl(path) {
    return state.agentUrl + "/api/knowledge" + path;
  }

  function setStatus(node, message, tone) {
    node.textContent = message || "";
    if (tone) {
      node.dataset.tone = tone;
    } else {
      delete node.dataset.tone;
    }
  }

  function renderAuthState() {
    var ready = Boolean(state.agentUrl && state.token);
    elements.workspace.hidden = !ready;
    elements.logoutButton.hidden = !ready;
    setStatus(
      elements.tokenStatus,
      ready ? "已保存到当前浏览器会话。" : "请输入服务地址和访问密钥。",
      ready ? "success" : "error"
    );
  }

  async function requestJson(path, options) {
    if (!state.agentUrl || !state.token) {
      throw new Error("请先填写服务地址和访问密钥。");
    }

    var requestOptions = Object.assign({}, options || {});
    var headers = new Headers(requestOptions.headers || {});
    headers.set("Authorization", "Bearer " + state.token);
    headers.set("Accept", "application/json");
    if (state.operator) {
      headers.set("X-Knowledge-Operator", state.operator);
    }
    requestOptions.headers = headers;

    var response = await fetch(apiUrl(path), requestOptions);
    var payload = null;
    var text = "";
    try {
      payload = await response.json();
    } catch (error) {
      text = await response.text();
    }
    if (!response.ok) {
      throw new Error((payload && payload.detail) || text || response.statusText);
    }
    return payload;
  }

  function formatBytes(value) {
    var size = Number(value || 0);
    var units = ["B", "KB", "MB", "GB"];
    var index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return (index ? size.toFixed(1) : Math.round(size)) + " " + units[index];
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
    if (ACTIVE_JOB_STATUSES.has(status)) {
      return "status processing";
    }
    return "status";
  }

  function renderQueue() {
    elements.fileQueue.replaceChildren();
    elements.queueCount.textContent = String(state.files.length);
    if (!state.files.length) {
      var empty = document.createElement("li");
      empty.className = "queue-item";
      empty.textContent = "暂无待上传文件";
      elements.fileQueue.appendChild(empty);
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
      elements.fileQueue.appendChild(item);
    });
  }

  function selectFiles(fileList) {
    state.files = Array.prototype.slice.call(fileList || []);
    renderQueue();
    setStatus(
      elements.uploadFeedback,
      state.files.length ? state.files.length + " 个文件待上传。" : "",
      state.files.length ? "success" : ""
    );
  }

  async function uploadFiles() {
    if (!state.files.length) {
      setStatus(elements.uploadFeedback, "请选择至少一个文件。", "error");
      return;
    }
    elements.uploadButton.disabled = true;
    setStatus(elements.uploadFeedback, "上传中...", "");

    var formData = new FormData();
    state.files.forEach(function (file) {
      formData.append("files", file, file.name);
    });

    try {
      var payload = await requestJson("/documents", {
        method: "POST",
        body: formData,
      });
      var items = Array.isArray(payload.items) ? payload.items : [];
      items.forEach(function (item) {
        if (item.job_id && ACTIVE_JOB_STATUSES.has(item.status)) {
          state.pollingJobs.add(item.job_id);
        }
      });
      state.files = [];
      elements.fileInput.value = "";
      renderQueue();
      setStatus(elements.uploadFeedback, "上传请求已提交。", "success");
      await refreshDocuments();
      ensurePolling();
    } catch (error) {
      setStatus(elements.uploadFeedback, error.message, "error");
    } finally {
      elements.uploadButton.disabled = false;
    }
  }

  function renderDocuments(documents) {
    elements.documentsBody.replaceChildren();
    if (!documents.length) {
      var row = document.createElement("tr");
      var cell = document.createElement("td");
      cell.colSpan = 4;
      cell.textContent = "暂无文档";
      row.appendChild(cell);
      elements.documentsBody.appendChild(row);
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
      elements.documentsBody.appendChild(row);
    });
  }

  async function refreshDocuments() {
    setStatus(elements.documentsFeedback, "加载中...", "");
    try {
      var payload = await requestJson("/documents?page=1&page_size=50", { method: "GET" });
      var items = payload && payload.data && Array.isArray(payload.data.items)
        ? payload.data.items
        : [];
      renderDocuments(items);
      setStatus(elements.documentsFeedback, "已刷新。", "success");
    } catch (error) {
      renderDocuments([]);
      setStatus(elements.documentsFeedback, error.message, "error");
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
        if (!job || !ACTIVE_JOB_STATUSES.has(job.status)) {
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

  function renderSearchResults(items) {
    elements.searchResults.replaceChildren();
    if (!items.length) {
      var empty = document.createElement("li");
      empty.className = "result-item";
      empty.textContent = "没有返回片段";
      elements.searchResults.appendChild(empty);
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
      elements.searchResults.appendChild(result);
    });
  }

  async function runSearch(event) {
    event.preventDefault();
    var query = elements.searchQuery.value.trim();
    var topK = Number(elements.searchTopK.value || 5);
    if (!query) {
      setStatus(elements.searchFeedback, "请输入查询。", "error");
      return;
    }
    elements.searchButton.disabled = true;
    setStatus(elements.searchFeedback, "检索中...", "");
    try {
      var payload = await requestJson("/search-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query, top_k: topK }),
      });
      var items = Array.isArray(payload.items) ? payload.items : [];
      renderSearchResults(items);
      setStatus(elements.searchFeedback, "返回 " + items.length + " 条结果。", "success");
    } catch (error) {
      renderSearchResults([]);
      setStatus(elements.searchFeedback, error.message, "error");
    } finally {
      elements.searchButton.disabled = false;
    }
  }

  function installEvents() {
    elements.authForm.addEventListener("submit", function (event) {
      event.preventDefault();
      state.agentUrl = normalizeAgentUrl(elements.agentUrlInput.value);
      state.token = elements.tokenInput.value.trim();
      state.operator = elements.operatorInput.value.trim();
      persistSession();
      renderAuthState();
      if (state.agentUrl && state.token) {
        void refreshDocuments();
      }
    });

    elements.logoutButton.addEventListener("click", function () {
      state.agentUrl = "";
      state.token = "";
      state.operator = "";
      persistSession();
      elements.agentUrlInput.value = "";
      elements.tokenInput.value = "";
      elements.operatorInput.value = "";
      renderAuthState();
      renderDocuments([]);
      renderSearchResults([]);
      stopPolling();
    });

    elements.refreshButton.addEventListener("click", function () {
      void refreshDocuments();
    });

    elements.uploadButton.addEventListener("click", function () {
      void uploadFiles();
    });

    elements.fileInput.addEventListener("change", function () {
      selectFiles(elements.fileInput.files);
    });

    ["dragenter", "dragover"].forEach(function (eventName) {
      elements.dropZone.addEventListener(eventName, function (event) {
        event.preventDefault();
        elements.dropZone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (eventName) {
      elements.dropZone.addEventListener(eventName, function (event) {
        event.preventDefault();
        elements.dropZone.classList.remove("is-dragover");
      });
    });
    elements.dropZone.addEventListener("drop", function (event) {
      if (event.dataTransfer && event.dataTransfer.files) {
        selectFiles(event.dataTransfer.files);
      }
    });
    elements.dropZone.addEventListener("click", function () {
      elements.fileInput.click();
    });
    elements.dropZone.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        elements.fileInput.click();
      }
    });

    elements.searchForm.addEventListener("submit", runSearch);
  }

  loadSession();
  renderAuthState();
  renderQueue();
  renderDocuments([]);
  renderSearchResults([]);
  installEvents();
  if (state.agentUrl && state.token) {
    void refreshDocuments();
  }
})();

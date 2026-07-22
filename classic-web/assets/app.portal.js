/*
 * app.网关.js — web-user 前端对接 网关 后端（方案B）
 * ------------------------------------------------------------------
 * 只改 API 层，完整保留原前端的页面/交互/DOM 结构（index.html 无需大改）。
 *
 * 鉴权：登录 /admin/api/auth/login 返回 session token（不是万能 key）。
 *   token 存 localStorage（沿用旧键 ai_user_auth_key，并镜像到 网关 的
 *   gw_token，方便管理员打开 网关 后台）。所有 /admin/api/* 调用都带
 *   Authorization: Bearer <token>。
 *
 * 出图方案选择：==> 采用「同步 /admin/api/generate」<==
 *   依据：网关 门户自带前端 PlaygroundView.vue 就是同步调 /admin/api/generate，
 *   请求体返回里直接带成品图 url（{data:[{url}], url, credits, charged, elapsed_ms}），
 *   后端 Generate handler 内部渲染+落盘后才返回，并不返回 job id 去轮询。
 *   /admin/api/jobs/mine 存在但门户前端根本没调用它，是给草稿跨标签同步用的。
 *   因此同步方案「改动最小 + 最稳」：无需轮询循环，无需 job 状态机。
 *   多张（数量>1）时按顺序逐张同步请求（并发会触发后端 409「已有正在生成的任务」）。
 *
 * 额度：/admin/api/auth/me 返回 {user:{credits,...}}，单一 credits 余额，
 *   没有 quota/used/unlimited 三件套；前端不再显示「无限」。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  function taskStorageKey(identity) {
    const uid = identity?.id || localStorage.getItem("ai_user_id") || "guest";
    return `ai_user_tasks_${uid}`;
  }
  function loadSavedTasks() {
    try {
      const parsed = JSON.parse(localStorage.getItem(taskStorageKey()) || localStorage.getItem("ai_user_tasks") || "[]");
      return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
    } catch {
      localStorage.removeItem(taskStorageKey());
      localStorage.removeItem("ai_user_tasks");
      return [];
    }
  }
  const state = {
    key: localStorage.getItem("ai_user_auth_key") || "",
    tasks: loadSavedTasks(),
    polling: new Set(),
    mode: "text",
    referenceFiles: [],
    presetTab: "text",
    identity: null,
    pricing: { base_1k: 1, plus_2k: 10, plus_4k: 30 },
    costs: { low: 1, medium: 11, high: 31 },
    videoConfig: { enabled: false, seconds_options: [6, 10, 12, 16, 20], per_second: 15, surcharge_720p: 0 },
    purchaseUrl: "",
    captcha: { id: "", question: "" },
    adminUrl: "/accounts/",
    creditHistory: [],
    creditHistoryPage: 1,
    creditHistoryPageSize: 10,
    creditHistoryTotal: 0,
    rechargeHistory: [],
    rechargeHistoryTotal: 0,
    rechargeHistoryPage: 1,
    rechargeHistoryPageSize: 10,
    selectMode: false,        // 生成结果的「选择/批量下载」模式
    selected: new Set(),      // 已选图片的 src 集合
    imageModels: [],          // /admin/api/models 返回的 image 类模型（含 ratios/resolutions）
    videoModels: [],          // managed-models 中已启用的 video 类模型
    apiKeyInfo: null,         // /admin/api/auth/api-key 返回的 {key_preview,...}（无则 null）
    apiKeyPlain: "",          // 刚 mint 出来的明文 key（仅本次会话内存，供复制）
  };
  const PROMPT_DRAFT_KEY = "image2api_classic_prompt_draft_v1";
  const REFERENCE_DRAFT_KEY = "image2api-classic-references-v1";

  function savePromptDraft() {
    try { localStorage.setItem(PROMPT_DRAFT_KEY, els.prompt.value || ""); } catch {}
  }

  function restorePromptDraft() {
    try { els.prompt.value = localStorage.getItem(PROMPT_DRAFT_KEY) || ""; } catch {}
    els.prompt.addEventListener("input", savePromptDraft);
  }

  function openDraftDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
      const req = indexedDB.open("ai-user-drafts", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveReferenceDraft() {
    try {
      const db = await openDraftDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        const store = tx.objectStore("drafts");
        if (state.referenceFiles.length) store.put(state.referenceFiles, REFERENCE_DRAFT_KEY);
        else store.delete(REFERENCE_DRAFT_KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    } catch {}
  }

  async function restoreReferenceDraft() {
    try {
      const db = await openDraftDb();
      const saved = await new Promise((resolve, reject) => {
        const req = db.transaction("drafts", "readonly").objectStore("drafts").get(REFERENCE_DRAFT_KEY);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      if (!state.referenceFiles.length && Array.isArray(saved)) {
        state.referenceFiles = saved.filter((file) => file instanceof Blob).slice(0, MAX_REF);
        renderReferences();
      }
    } catch {}
  }
  // 网关 会话 token 同时镜像到 gw_token（网关 前端约定的键），
  // 让管理员跳转到 网关 后台（同源 SPA）时能直接复用登录态。
  function setSessionToken(token) {
    state.key = token || "";
    try {
      if (token) { localStorage.setItem("ai_user_auth_key", token); localStorage.setItem("gw_token", token); }
      else { localStorage.removeItem("ai_user_auth_key"); localStorage.removeItem("gw_token"); }
    } catch {}
  }

  function clearExpiredSession() {
    setSessionToken("");
    state.identity = null;
    state.apiKeyPlain = "";
    state.apiKeyInfo = null;
    updateAuthUI();
    setAuthTab("login");
    setAuthInlineMsg("登录信息已过期，请重新登录", "error");
    if (els.loginDialog && !els.loginDialog.open) els.loginDialog.showModal();
  }

  const els = {
    loginBtn: $("loginBtn"), registerBtn: $("registerBtn"), logoutBtn: $("logoutBtn"), authState: $("authState"),
    loginDialog: $("loginDialog"), keyInput: $("keyInput"), loginUsernameInput: $("loginUsernameInput"), loginPasswordInput: $("loginPasswordInput"), saveKeyBtn: $("saveKeyBtn"), loginTabBtn: $("loginTabBtn"), registerTabBtn: $("registerTabBtn"), loginPane: $("loginPane"), registerPane: $("registerPane"), registerSubmitBtn: $("registerSubmitBtn"), registerUsernameInput: $("registerUsernameInput"), registerPasswordInput: $("registerPasswordInput"), registerPasswordConfirmInput: $("registerPasswordConfirmInput"), registerNameInput: $("registerNameInput"), captchaAnswerInput: $("captchaAnswerInput"), refreshCaptchaBtn: $("refreshCaptchaBtn"), captchaQuestion: $("captchaQuestion"), registerResult: $("registerResult"), authInlineMsg: $("authInlineMsg"),
    prompt: $("promptInput"), model: $("modelSelect"), size: $("sizeSelect"), quality: $("qualitySelect"), count: $("countSelect"),
    textModeBtn: $("textModeBtn"), imageModeBtn: $("imageModeBtn"), imageUploadBox: $("imageUploadBox"), imageInput: $("imageInput"), pickImageBtn: $("pickImageBtn"), referenceList: $("referenceList"), presetList: $("presetList"), presetToggleBtn: $("presetToggleBtn"), presetPopover: $("presetPopover"),
    videoModeBtn: $("videoModeBtn"), imageControls: $("imageControls"), videoControls: $("videoControls"), videoModel: $("videoModelSelect"), vidSeconds: $("vidSeconds"), vidResolution: $("vidResolution"), vidOrient: $("vidOrient"), vidPreset: $("vidPreset"), vidRefHint: $("vidRefHint"),
    generate: $("generateBtn"), autoRetryToggle: $("autoRetryToggle"), autoRetryCount: $("autoRetryCount"), costHint: $("costHint"), message: $("message"), output: $("outputList"), clear: $("clearBtn"),
    selectModeBtn: $("selectModeBtn"), selectAllBtn: $("selectAllBtn"), downloadSelectedBtn: $("downloadSelectedBtn"), exitSelectBtn: $("exitSelectBtn"),
    creditState: $("creditState"), userRole: $("userRole"), userInfo: $("userInfo"), apiRole: $("apiRole"), apiInfo: $("apiInfo"), redeemCodeInput: $("redeemCodeInput"), redeemBtn: $("redeemBtn"), redeemMessage: $("redeemMessage"), purchaseBtn: $("purchaseBtn"), rechargeHistoryList: $("rechargeHistoryList"), refreshRechargeHistoryBtn: $("refreshRechargeHistoryBtn"), historyList: $("historyList"), refreshHistoryBtn: $("refreshHistoryBtn"),
    centerModal: $("centerModal"), centerModalTitle: $("centerModalTitle"), centerModalMessage: $("centerModalMessage"), centerModalCancel: $("centerModalCancel"), centerModalConfirm: $("centerModalConfirm"),
    announceModal: $("announceModal"), announceModalBody: $("announceModalBody"), announceModalClose: $("announceModalClose"),
    lightbox: $("lightbox"), lightboxImg: $("lightboxImg"), closeLightbox: $("closeLightbox"),
    zoomOutBtn: $("zoomOutBtn"), zoomInBtn: $("zoomInBtn"), rotateLeftBtn: $("rotateLeftBtn"), rotateRightBtn: $("rotateRightBtn"), resetViewBtn: $("resetViewBtn"), downloadLightbox: $("downloadLightbox"), prevImageBtn: $("prevImageBtn"), nextImageBtn: $("nextImageBtn"),
  };

  function uid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  // 落盘时剥掉 base64 大图（一张 1~3MB，localStorage 只有约 5MB 配额），内存中仍保留供当次会话显示；
  // 刷新后由 syncRecentBackendTasks/resumePendingTasks 按 taskId 从服务器自动补回
  function persistableTask(task) {
    if (!Array.isArray(task.images) || !task.images.length) return task;
    let changed = false;
    const images = task.images.map((img) => {
      if (!img) return img;
      const hasB64 = !!img.b64_json;
      const hasDataUrl = typeof img.url === "string" && img.url.startsWith("data:");
      if (!hasB64 && !hasDataUrl) return img;
      changed = true;
      const copy = { ...img };
      delete copy.b64_json;
      if (hasDataUrl) delete copy.url;
      return copy;
    });
    return changed ? { ...task, images } : task;
  }
  function saveTasks() {
    const key = taskStorageKey(state.identity);
    let tasks = state.tasks.slice(0, 50).map(persistableTask);
    for (;;) {
      try { localStorage.setItem(key, JSON.stringify(tasks)); return; }
      catch {
        // 仍超配额（比如别的 key 占满了）：砍半重试，绝不让保存失败打断出图流程
        if (!tasks.length) { try { localStorage.removeItem(key); } catch {} return; }
        tasks = tasks.slice(0, Math.floor(tasks.length / 2));
      }
    }
  }
  function setMessage(text, type = "") { els.message.textContent = text || ""; els.message.className = `message ${type}`; }

  function setAuthInlineMsg(text, type = "") {
    if (!els.authInlineMsg) return;
    els.authInlineMsg.textContent = text || "";
    els.authInlineMsg.className = `auth-inline-msg ${type || ""} ${text ? "" : "hidden"}`;
  }
  function showToast(text, type = "error") {
    let box = document.getElementById("toastBox");
    if (!box) { box = document.createElement("div"); box.id = "toastBox"; box.className = "toast-box"; document.body.appendChild(box); }
    const item = document.createElement("div");
    item.className = `toast-item ${type}`;
    item.textContent = text || "操作失败";
    box.appendChild(item);
    setTimeout(() => item.classList.add("show"), 10);
    setTimeout(() => { item.classList.remove("show"); setTimeout(() => item.remove(), 220); }, 3200);
  }
  // 复制文本：优先 Clipboard API，失败回退 execCommand（http/旧浏览器兜底）。
  async function copyText(text) {
    const value = String(text || "");
    if (!value) return false;
    try { await navigator.clipboard.writeText(value); return true; }
    catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = value; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand("copy"); ta.remove(); return ok;
      } catch { return false; }
    }
  }
  // 通用图片放大浮层（使用日志缩略图点击放大用；与「我的图片」共用 #myImgLightbox 容器）。
  function showSimpleLightbox(full, caption) {
    if (!full) return;
    let ov = document.getElementById("myImgLightbox");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "myImgLightbox";
      ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.88);display:none;align-items:center;justify-content:center;flex-direction:column;padding:24px;cursor:zoom-out";
      ov.addEventListener("click", () => { ov.style.display = "none"; });
      document.body.appendChild(ov);
    }
    const cap = caption ? `<div style="color:#eee;margin-top:14px;max-width:82vw;text-align:center;font-size:13px;line-height:1.55;max-height:18vh;overflow:auto">${escapeHtml(caption)}</div>` : "";
    ov.innerHTML = `<img src="${escapeHtml(full)}" alt="" style="max-width:94vw;max-height:80vh;object-fit:contain;border-radius:8px;box-shadow:0 10px 44px rgba(0,0,0,.55)"/>${cap}<div style="color:#aaa;margin-top:10px;font-size:12px">点击任意处关闭 · <a href="${escapeHtml(full)}" target="_blank" rel="noopener" style="color:#7ab8ff">查看/下载原图</a></div>`;
    ov.style.display = "flex";
  }
  function showCenterConfirm({ title = "提示", message = "", confirmText = "确定", cancelText = "取消", danger = false } = {}) {
    if (!els.centerModal) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const close = (value) => {
        if (done) return;
        done = true;
        els.centerModal.classList.add("hidden");
        els.centerModalConfirm.onclick = null;
        els.centerModalCancel.onclick = null;
        els.centerModal.onclick = null;
        document.removeEventListener("keydown", onKeydown);
        resolve(value);
      };
      const onKeydown = (event) => {
        if (event.key === "Escape") close(false);
        if (event.key === "Enter") close(true);
      };
      els.centerModalTitle.textContent = title;
      els.centerModalMessage.textContent = message || "";
      els.centerModalConfirm.textContent = confirmText;
      els.centerModalCancel.textContent = cancelText;
      els.centerModalConfirm.classList.toggle("danger", !!danger);
      els.centerModal.classList.remove("hidden");
      els.centerModalConfirm.onclick = () => close(true);
      els.centerModalCancel.onclick = () => close(false);
      els.centerModal.onclick = (event) => { if (event.target === els.centerModal) close(false); };
      document.addEventListener("keydown", onKeydown);
      setTimeout(() => els.centerModalConfirm?.focus(), 0);
    });
  }
  function maskKey(key) {
    const v = String(key || "");
    if (v.length <= 12) return v ? `${v.slice(0, 3)}****${v.slice(-3)}` : "--";
    return `${v.slice(0, 8)}••••••••••••${v.slice(-6)}`;
  }
  function authHeaders() { return { "Authorization": `Bearer ${state.key}`, "Content-Type": "application/json" }; }

  const PRESETS = {
    text: [
      ["\u5199\u5b9e\u4eba\u50cf", "\u4e13\u4e1a\u68da\u62cd\u8d28\u611f\uff0c\u81ea\u7136\u5149\u5f71\uff0c\u6d45\u666f\u6df1"],
      ["\u52a8\u6f2b\u4eba\u7269", "\u65e5\u7cfb\u52a8\u6f2b\u98ce\u683c\uff0c\u5409\u535c\u529b\u7f8e\u672f\u98ce"],
      ["\u8d5b\u535a\u670b\u514b\u57ce\u5e02", "\u9701\u8679\u591c\u666f\u90fd\u5e02\uff0c\u96e8\u540e\u53cd\u5149\u8857\u9053"],
      ["\u6c34\u58a8\u5c71\u6c34", "\u4e2d\u5f0f\u4f20\u7edf\u6cfc\u58a8\u5c71\u6c34\uff0c\u610f\u5883\u60a0\u8fdc"],
      ["\u5546\u54c1\u5c55\u793a", "\u6781\u7b80\u80cc\u666f\u5546\u4e1a\u7ea7\u4ea7\u54c1\u6444\u5f71"],
      ["\u5947\u5e7b\u573a\u666f", "\u9b54\u5e7b\u68ee\u6797\uff0c\u53d1\u5149\u5143\u7d20\uff0c\u53f2\u8bd7\u5947\u5e7b\u98ce"],
    ],
    image: [
      ["\u7535\u5546\u4ea7\u54c1\u6d77\u62a5", "\u4e0a\u4f20\u4ea7\u54c1\u56fe\uff0c\u81ea\u52a8\u751f\u6210\u7cbe\u7f8e\u7535\u5546\u5ba3\u4f20\u6d77\u62a5", "\u4e0a\u4f20 1 \u5f20\uff1a\u9700\u8981\u5236\u4f5c\u6d77\u62a5\u7684\u4ea7\u54c1\u56fe\uff08\u5efa\u8bae\u7eaf\u8272\u6216\u900f\u660e\u80cc\u666f\uff0c\u4ea7\u54c1\u6e05\u6670\u5b8c\u6574\uff09"],
      ["\u66ff\u6362\u80cc\u666f", "\u4fdd\u7559\u4e3b\u4f53\u4eba\u7269\u6216\u7269\u4f53\uff0c\u66f4\u6362\u80cc\u666f\u573a\u666f", "\u4e0a\u4f20 1 \u5f20\uff1a\u9700\u66ff\u6362\u80cc\u666f\u7684\u7167\u7247\uff08\u4e3b\u4f53\u8f6e\u5ed3\u8d8a\u6e05\u6670\u6548\u679c\u8d8a\u597d\uff09"],
      ["\u5408\u7167\u5408\u6210", "\u5c06\u4e24\u5f20\u5355\u4eba\u7167\u5408\u6210\u4e00\u5f20\u81ea\u7136\u5408\u5f71", "\u4e0a\u4f20 2 \u5f20\uff1a\u7b2c\u4e00\u5f20\u4e3a\u7b2c\u4e00\u4f4d\u4eba\u7269\u7684\u7167\u7247\uff0c\u7b2c\u4e8c\u5f20\u4e3a\u7b2c\u4e8c\u4f4d\u4eba\u7269\u7684\u7167\u7247"],
      ["\u6362\u88c5\uff08\u6587\u5b57\u63cf\u8ff0\uff09", "\u4fdd\u7559\u4eba\u7269\u9762\u5bb9\u4e0e\u4f53\u578b\uff0c\u6309\u63cf\u8ff0\u66ff\u6362\u670d\u88c5", "\u4e0a\u4f20 1 \u5f20\uff1a\u9700\u8981\u6362\u88c5\u7684\u4eba\u7269\u7167\u7247\uff08\u5efa\u8bae\u6e05\u6670\u5c55\u793a\u5168\u8eab\u6216\u4e0a\u534a\u8eab\u6b63\u9762\uff09"],
      ["\u6362\u88c5\uff08\u53c2\u8003\u670d\u88c5\uff09", "\u5c06\u6307\u5b9a\u670d\u88c5\u7a7f\u5728\u6a21\u7279\u8eab\u4e0a\uff0c\u4fdd\u7559\u9762\u5bb9\u4f53\u578b", "\u4e0a\u4f20 2 \u5f20\uff1a\u7b2c\u4e00\u5f20\u4e3a\u6a21\u7279\u4eba\u7269\u7167\u7247\uff08\u5efa\u8bae\u5168\u8eab\u6216\u4e0a\u534a\u8eab\u6b63\u9762\uff09\uff0c\u7b2c\u4e8c\u5f20\u4e3a\u76ee\u6807\u670d\u88c5\u7167\u7247"],
      ["\u98ce\u683c\u8f6c\u6362", "\u7167\u7247\u8f6c\u5409\u535c\u529b\u52a8\u6f2b\u63d2\u753b\u98ce\u683c", "\u4e0a\u4f20 1 \u5f20\uff1a\u9700\u8981\u98ce\u683c\u8f6c\u6362\u7684\u539f\u59cb\u7167\u7247"],
      ["\u65e7\u7167\u7247\u4fee\u590d", "\u4fee\u590d\u5212\u75d5\u3001\u6c61\u6e0d\u3001\u892a\u8272\uff0c\u8fd8\u539f\u6e05\u6670\u7ec6\u8282", "\u4e0a\u4f20 1 \u5f20\uff1a\u9700\u8981\u4fee\u590d\u7684\u65e7\u7167\u7247\uff08\u626b\u63cf\u4ef6\u6216\u7ffb\u62cd\u5747\u53ef\uff09"],
      ["\u5c40\u90e8\u91cd\u7ed8", "\u63cf\u8ff0\u8981\u4fee\u6539\u7684\u533a\u57df\uff0c\u5176\u4f59\u4fdd\u6301\u4e0d\u53d8", "\u4e0a\u4f20 1 \u5f20\uff1a\u9700\u8981\u5c40\u90e8\u4fee\u6539\u7684\u539f\u59cb\u56fe\u7247"],
      ["\u4eba\u7269\u878d\u5408", "\u5c06\u4e24\u4e2a\u4eba\u7269\u81ea\u7136\u878d\u5165\u540c\u4e00\u573a\u666f", "\u4e0a\u4f20 2 \u5f20\uff1a\u7b2c\u4e00\u5f20\u4e3a\u7b2c\u4e00\u4f4d\u4eba\u7269\u7167\u7247\uff0c\u7b2c\u4e8c\u5f20\u4e3a\u7b2c\u4e8c\u4f4d\u4eba\u7269\u7167\u7247"],
    ],
  };

  function renderPresets() {
    if (!els.presetList) return;
    const tab = state.presetTab === "image" ? "image" : "text";
    const tabs = `<div class="case-tabs"><span class="case-tab ${tab === "text" ? "active" : ""}" data-preset-tab="text">\u6587\u751f\u56fe</span><span class="case-tab ${tab === "image" ? "active" : ""}" data-preset-tab="image">\u56fe\u751f\u56fe</span></div>`;
    const items = (PRESETS[tab] || []).map(([title, desc, guide]) => {
      const prompt = `${title}\uff0c${desc}`;
      const guideHtml = guide ? `<span class="case-image-guide">${escapeHtml(guide)}</span>` : "";
      return `<div class="case-item" data-prompt="${escapeHtml(prompt)}"><span class="case-title">${escapeHtml(title)}</span><span class="case-desc">${escapeHtml(desc)}</span>${guideHtml}</div>`;
    }).join("");
    els.presetList.innerHTML = `<div class="case-dropdown-panel">${tabs}${items}</div>`;
  }

  function setMode(mode) {
    state.mode = (mode === "image" || mode === "video") ? mode : "text";
    const isVideo = state.mode === "video";
    els.textModeBtn.classList.toggle("active", state.mode === "text");
    els.imageModeBtn.classList.toggle("active", state.mode === "image");
    if (els.videoModeBtn) els.videoModeBtn.classList.toggle("active", isVideo);
    if (els.imageControls) els.imageControls.classList.toggle("hidden", isVideo);
    if (els.videoControls) els.videoControls.classList.toggle("hidden", !isVideo);
    refreshUploadBox();
    state.presetTab = isVideo ? "text" : state.mode;
    renderPresets();
    updateCostHint();
  }

  // 参考图上传框按当前模型的 max_reference_images 动态显示。
  function refreshUploadBox() {
    const isImage = state.mode === "image";
    const isVideo = state.mode === "video";
    const videoMaxRefs = Math.max(0, Number(currentVideoModel()?.max_reference_images || 0));
    if (isVideo && videoMaxRefs === 0 && state.referenceFiles && state.referenceFiles.length) {
      state.referenceFiles = [];
      renderReferences();
    }
    const videoRefAllowed = isVideo && videoMaxRefs > 0;
    els.imageUploadBox.classList.toggle("hidden", !(isImage || videoRefAllowed));
    if (els.vidRefHint) els.vidRefHint.classList.add("hidden");
    updatePickBtn();
  }

  const MAX_REF = 6;  // 参考图最多 6 张（图生视频/图生图上限）
  function maxReferenceFiles() {
    return state.mode === "video" ? Math.max(0, Number(currentVideoModel()?.max_reference_images || 0)) : MAX_REF;
  }
  let creditAlertPromise = null;
  function isInsufficientCredits(value) {
    const text = String(value || "").toLowerCase();
    return text.includes("insufficient credits") || text.includes("积分不足");
  }
  function showInsufficientCredits(required, balance) {
    if (creditAlertPromise) return creditAlertPromise;
    const need = Math.max(0, Number(required) || 0);
    const current = Math.max(0, Number(balance) || 0);
    creditAlertPromise = showCenterConfirm({
      title: "积分不足",
      message: `本次需要 ${need} 积分，当前余额 ${current} 积分。请先充值或兑换后再生成。`,
      confirmText: "去充值",
      cancelText: "关闭",
    }).then((go) => { if (go) showPage("recharge"); return go; })
      .finally(() => { creditAlertPromise = null; });
    return creditAlertPromise;
  }
  let refObjectUrls = [];
  function updatePickBtn() {
    if (!els.pickImageBtn) return;
    const maxRefs = maxReferenceFiles();
    const full = maxRefs <= 0 || (state.referenceFiles || []).length >= maxRefs;
    els.pickImageBtn.disabled = full;
    const _pb = document.getElementById("pasteImageBtn");
    if (_pb) _pb.disabled = full;
    const base = state.mode === "video" ? `上传参考图（可选，最多${maxRefs}张）` : `上传参考图（最多${MAX_REF}张）`;
    els.pickImageBtn.textContent = full ? `参考图已满（最多${maxRefs}张）` : base;
  }
  function renderReferences() {
    // 释放上次的预览 URL，避免内存泄漏
    refObjectUrls.forEach(url => URL.revokeObjectURL(url));
    refObjectUrls = [];
    els.referenceList.innerHTML = state.referenceFiles.map((file, index) => {
      // 每张参考图都渲染成缩略图，各自带移除按钮
      const url = URL.createObjectURL(file);
      refObjectUrls.push(url);
      return `<div class="reference-item"><img class="reference-preview" src="${url}" alt="${escapeHtml(file.name)}" title="${escapeHtml(file.name)}" /><button class="reference-remove" type="button" data-remove-ref="${index}" aria-label="移除">&times;</button></div>`;
    }).join("");
    updatePickBtn();
    void saveReferenceDraft();
  }

  // 网关 后台是同源 Vue SPA，登录态就是 localStorage 里的 gw_token。
  // setSessionToken() 已把会话 token 镜像到 gw_token，所以直接打开 adminUrl 即可自动带登录态。
  async function primeAdminSession() {
    if (state.identity?.role !== "admin" || !state.key) return false;
    try { localStorage.setItem("gw_token", state.key); } catch {}
    return true;
  }

  async function openAdmin() {
    const target = "/new/admin";
    try { await primeAdminSession(); } catch (err) { console.warn("prime admin session failed", err); }
    // 同源同标签跳转即可（gw_token 已在 localStorage，网关 SPA 会读取）。
    try { window.location.assign(target); } catch { window.location.href = target; }
  }

  function updateTopUserInfo() {
    let box = document.getElementById("topUserInfo");
    const nav = document.querySelector(".nav");
    if (!nav) return;
    if (!box) {
      box = document.createElement("div");
      box.id = "topUserInfo";
      box.className = "top-user-info";
      nav.prepend(box);
    }
    if (!state.key || !state.identity) { box.innerHTML = ""; return; }
    const name = state.identity.username || state.identity.name || "用户";
    const remain = formatRemaining(state.identity);
    const adminLink = state.identity?.role === "admin" ? `<button type="button" data-top-admin>进入后台</button>` : "";
    box.innerHTML = `<span>积分余额 ${escapeHtml(remain)}</span><button type="button" data-top-recharge>充值</button>${adminLink}<strong>${escapeHtml(name)}</strong>`;
    const btn = box.querySelector("[data-top-recharge]");
    if (btn) btn.onclick = () => showPage("recharge");
    const adminBtn = box.querySelector("[data-top-admin]");
    if (adminBtn) adminBtn.onclick = () => { void openAdmin(); };
  }

  function updateAuthUI() {
    const ok = !!state.key;
    const identity = state.identity || null;
    const remaining = identity ? formatRemaining(identity) : "--";
    els.authState.textContent = ok ? `已登录 · 余额 ${remaining}` : "未登录";
    els.authState.className = ok ? "pill" : "pill muted";
    els.loginBtn.classList.toggle("hidden", ok);
    els.registerBtn?.classList.toggle("hidden", ok);
    els.logoutBtn.classList.toggle("hidden", !ok);
    if (els.creditState) {
      els.creditState.textContent = ok ? `余额 ${remaining}` : "未登录";
      els.creditState.className = ok ? "pill" : "pill muted";
    }
    if (els.userRole) {
      els.userRole.textContent = identity ? (identity.role === "admin" ? "管理员" : "普通用户") : "游客";
      els.userRole.className = identity ? "pill" : "pill muted";
    }
    if (els.apiRole) {
      els.apiRole.textContent = identity ? (identity.role === "admin" ? "管理员" : "普通用户") : "游客";
      els.apiRole.className = identity ? "pill" : "pill muted";
    }
    renderUserInfo();
    renderApiInfo();
    updateTopUserInfo();
  }

  function formatRemaining(identity) {
    // 网关 只有单一 credits 余额，没有 quota/used/unlimited。
    if (!identity) return "--";
    const remaining = Number(identity.credits ?? identity.remaining ?? 0);
    return String(Math.max(0, Math.round(remaining)));
  }

  function renderUserInfo() {
    if (!els.userInfo) return;
    const identity = state.identity;
    if (!state.key) {
      els.userInfo.innerHTML = `<p>登录后查看用户名称、积分余额和使用情况。</p>`;
      return;
    }
    if (!identity) {
      els.userInfo.innerHTML = `<p>正在读取用户信息...</p>`;
      return;
    }
    const remaining = formatRemaining(identity);
    // 网关 PublicUser：credits(余额) / recharge_total(累计充值) / concurrency_limit(0=不限)。
    const rechargeTotal = String(identity.recharge_total ?? 0);
    const imageConcurrency = Number(identity.concurrency_limit || 0);
    const imageConcurrencyText = imageConcurrency > 0 ? `${imageConcurrency} 个` : "不限制";
    els.userInfo.innerHTML = `
      <div class="user-stat-grid">
        <div class="user-stat"><span>用户名称</span><strong>${escapeHtml(identity.name || identity.username || "用户")}</strong></div>
        <div class="user-stat"><span>账号角色</span><strong>${escapeHtml(identity.role === "admin" ? "管理员" : "普通用户")}</strong></div>
        <div class="user-stat"><span>剩余积分</span><strong>${escapeHtml(remaining)}</strong></div>
        <div class="user-stat"><span>累计充值</span><strong>${escapeHtml(rechargeTotal)}</strong></div>
        <div class="user-stat"><span>并发限制</span><strong>${escapeHtml(imageConcurrencyText)}</strong></div>
      </div>
      ${identity.role === "user" ? `<div class="api-key-card"><span>修改密码</span><input id="oldPwInput" class="text-input" type="password" placeholder="原密码" autocomplete="current-password" style="margin-top:8px" /><input id="newPwInput" class="text-input" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" style="margin-top:8px" /><input id="newPw2Input" class="text-input" type="password" placeholder="再次输入新密码" autocomplete="new-password" style="margin-top:8px" /><div class="api-key-actions" style="margin-top:10px"><button id="changePwBtn" type="button" class="primary-btn small">保存新密码</button></div><p id="changePwMsg" class="message"></p></div>` : ""}
      ${identity.role === "admin" ? `<div class="api-key-card"><div class="api-key-row"><div><span>后台管理</span><code>${escapeHtml(state.adminUrl || "/accounts/")}</code></div><button id="openAdminBtn" type="button" class="secondary-btn">进入后台</button></div></div>` : ""}`;
    const openAdminBtn = document.getElementById("openAdminBtn");
    if (openAdminBtn) openAdminBtn.onclick = () => { void openAdmin(); };
    const changePwBtn = document.getElementById("changePwBtn");
    if (changePwBtn) changePwBtn.onclick = () => { void changePassword(); };
  }

  async function changePassword() {
    const oldPw = document.getElementById("oldPwInput")?.value || "";
    const newPw = document.getElementById("newPwInput")?.value || "";
    const newPw2 = document.getElementById("newPw2Input")?.value || "";
    const msg = document.getElementById("changePwMsg");
    const setMsg = (t, cls) => { if (msg) { msg.textContent = t; msg.className = "message" + (cls ? " " + cls : ""); } };
    if (!oldPw || !newPw) { setMsg("请填写原密码和新密码", "error"); return; }
    if (newPw.length < 6) { setMsg("新密码至少 6 位", "error"); return; }
    if (newPw !== newPw2) { setMsg("两次新密码不一致", "error"); return; }
    try {
      await api("/admin/api/auth/change-password", { method: "POST", headers: authHeaders(), body: JSON.stringify({ current_password: oldPw, new_password: newPw }) });
      setMsg("密码已修改", "ok");
      ["oldPwInput", "newPwInput", "newPw2Input"].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });
      showToast("密码修改成功", "ok");
    } catch (e) {
      setMsg(e.message || "修改失败", "error");
    }
  }

  // 网关：会话 token ≠ API Key。API Key 需单独 mint（POST /admin/api/auth/api-key），
  // 明文只在 mint 那一刻返回一次；GET 只拿到 key_preview（掩码）。
  async function loadApiKey() {
    if (!state.key) return;
    try {
      const d = await api("/admin/api/auth/api-key", { headers: authHeaders() });
      state.apiKeyInfo = d.key || null;
      renderApiInfo();
    } catch { /* 拿不到就当没有 */ }
  }
  async function mintApiKey() {
    const d = await api("/admin/api/auth/api-key", { method: "POST", headers: authHeaders(), body: "{}" });
    const full = d.key || "";
    if (!full) throw new Error("后端未返回新密钥");
    state.apiKeyPlain = full;
    state.apiKeyInfo = { key_preview: maskKey(full) };
    renderApiInfo();
    return full;
  }

  function renderApiInfo() {
    if (!els.apiInfo) return;
    const identity = state.identity;
    if (!state.key) {
      els.apiInfo.innerHTML = `<p>登录后查看 API Key、Base URL 和调用方式。</p>`;
      return;
    }
    if (!identity) {
      els.apiInfo.innerHTML = `<p>正在读取 API 配置...</p>`;
      return;
    }
    const apiOrigin = location.origin;
    // 明文密钥现在持久保存,可直接复制;展示始终用掩码(sk-xxx••••••-xxxxx)。
    const plainKey = state.apiKeyPlain || (state.apiKeyInfo && state.apiKeyInfo.plain) || "";
    const previewKey = (state.apiKeyInfo && state.apiKeyInfo.key_preview) || (plainKey ? maskKey(plainKey) : "");
    const hasKey = !!(plainKey || previewKey);
    const keyDisplay = previewKey ? escapeHtml(previewKey) : "尚未生成";
    const plainHint = hasKey
      ? `<p class="muted-text" style="margin-top:6px">点「一键复制密钥」即可复制你的完整密钥;如需更换,点「重新生成密钥」(旧密钥立即失效)。</p>`
      : `<p class="muted-text" style="margin-top:6px">你还没有 API 密钥。点「生成密钥」即可创建。</p>`;
    const mintLabel = hasKey ? "重新生成密钥" : "生成密钥";
    els.apiInfo.innerHTML = `
      <div class="api-key-card">
        <div class="api-key-row"><div><span>API Key</span><code>${keyDisplay}</code></div><div class="api-key-actions"><button id="copyUserKeyBtn" type="button" class="secondary-btn">一键复制密钥</button><button id="regenUserKeyBtn" type="button" class="secondary-btn">${mintLabel}</button></div></div>
        ${plainHint}
        <div class="api-key-row base-url-row"><div><span>Base URL</span><code>${escapeHtml(apiOrigin)}/v1</code></div><button id="copyBaseUrlBtn" type="button" class="secondary-btn">复制 Base URL</button></div>
        <div class="call-guide"><span>OpenAI 兼容调用方式（Base URL: ${escapeHtml(apiOrigin)}/v1）</span>
          <div class="api-example" style="margin-top:8px">
            <div class="api-example-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><strong>① 文生图 · gpt-image-2</strong><button id="copyImgExample" type="button" class="secondary-btn" style="padding:3px 12px;font-size:12px">复制</button></div>
            <pre id="imgExamplePre" style="white-space:pre;overflow:auto"></pre>
            <p class="muted-text" style="margin-top:8px;line-height:1.8"><b>把 <code>$API_KEY</code> 换成你的密钥</b>（用上方「一键复制密钥」获取，示例里不显示你的真实密钥）。<br><b>size 比例</b>：传 <code>宽x高</code>，只决定画面比例。前端常用 5 种：<code>1024x1024</code> = 方形 1:1 · <code>768x1024</code> = 竖版 3:4 · <code>720x1280</code> = 故事版 9:16 · <code>1024x768</code> = 横版 4:3 · <code>1280x720</code> = 宽屏 16:9；<code>auto</code> = 自动/默认比例。具体可用比例以所选模型为准。<br><b>quality 清晰度/超分</b>：独立于 size；不传或 <code>low</code> = 1K · <code>medium</code> = 2K · <code>high</code> = 4K · <code>auto</code> = 模型默认档。两者可以同时传，模型不支持目标档位时自动使用可用档位。</p>
          </div>
        </div>
      </div>`;
    const copyBtn = document.getElementById("copyUserKeyBtn");
    if (copyBtn) copyBtn.onclick = async () => {
      // 有明文（持久保存或刚生成）→ 直接复制完整明文,不重新生成。
      const plainNow = state.apiKeyPlain || (state.apiKeyInfo && state.apiKeyInfo.plain) || "";
      if (plainNow) {
        const ok = await copyText(plainNow);
        showToast(ok ? "密钥已复制" : "复制失败，请手动复制", ok ? "ok" : "error");
        return;
      }
      // 无明文（网关 掩码不可回读）→ 确认后重新生成一把新密钥并立即复制（旧密钥失效）。
      const confirmed = await showCenterConfirm({
        title: hasKey ? "重新生成并复制密钥" : "生成并复制密钥",
        message: hasKey
          ? "为保护密钥，系统只保存掩码，明文无法再次读取。继续将重新生成一把新密钥并立即复制到剪贴板，旧密钥会立即失效。是否继续？"
          : "你还没有 API 密钥。继续将为你生成一把新密钥并立即复制到剪贴板（明文仅本次显示一次）。",
        confirmText: hasKey ? "重新生成并复制" : "生成并复制",
      });
      if (!confirmed) return;
      copyBtn.disabled = true;
      try {
        const nextKey = await mintApiKey();
        const ok = await copyText(nextKey);
        showToast(ok ? "新密钥已生成并复制" : "新密钥已生成，请手动复制", "ok");
      } catch (e) {
        showToast(e.message || "生成失败", "error");
      } finally {
        copyBtn.disabled = false;
      }
    };
    const regenBtn = document.getElementById("regenUserKeyBtn");
    if (regenBtn) regenBtn.onclick = async () => {
      const confirmed = await showCenterConfirm({
        title: hasKey ? "重新生成密钥" : "生成密钥",
        message: hasKey ? "重新生成后，旧密钥会立即失效。确定继续？" : "将为你的账号生成一个 API 密钥，用于 OpenAI 兼容调用。",
        confirmText: "确认生成",
      });
      if (!confirmed) return;
      regenBtn.disabled = true;
      try {
        const nextKey = await mintApiKey();
        try { await navigator.clipboard.writeText(nextKey); showToast("新密钥已生成并复制", "ok"); }
        catch { showToast("新密钥已生成，请手动复制", "ok"); }
      } catch (e) {
        showToast(e.message || "生成失败", "error");
      } finally {
        regenBtn.disabled = false;
      }
    };
    const copyBaseBtn = document.getElementById("copyBaseUrlBtn");
    if (copyBaseBtn) copyBaseBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(`${apiOrigin}/v1`); showToast("Base URL 已复制", "ok"); }
      catch { showToast("复制失败，请手动复制", "error"); }
    };
    // 示例统一用占位符 $API_KEY，绝不显示/复制真实密钥（用户自行替换，防截图泄露）
    const IMG_EXAMPLE = `curl ${apiOrigin}/v1/images/generations \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-image-2","prompt":"一只戴墨镜的柴犬，工作室灯光","size":"1024x1024","quality":"medium"}'`;
    const imgPre = document.getElementById("imgExamplePre");
    if (imgPre) imgPre.textContent = IMG_EXAMPLE;
    const copyImgBtn = document.getElementById("copyImgExample");
    if (copyImgBtn) copyImgBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(IMG_EXAMPLE); showToast("示例已复制（把 $API_KEY 换成你的密钥）", "ok"); }
      catch { showToast("复制失败，请手动复制", "error"); }
    };
  }

  async function refreshMe() {
    if (!state.key) { state.identity = null; updateAuthUI(); return null; }
    try {
      // 网关：GET /admin/api/auth/me → { ok, expires_at, user:{...credits...} }
      const data = await api("/admin/api/auth/me", { headers: authHeaders() });
      state.identity = data.user || null;
      if (state.identity?.id) localStorage.setItem("ai_user_id", state.identity.id);
      updateAuthUI();
      return state.identity;
    } catch (e) {
      state.identity = null;
      if (e?.status === 401) clearExpiredSession();
      else updateAuthUI();
      throw e;
    }
  }


  function formatCreditTime(value) {
    if (!value) return "-";
    // 数字 = 网关 的 Unix 秒(credit-logs created_at);字符串 = ISO 时间。
    const d = typeof value === "number" ? new Date(value * 1000) : new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  }

  // 使用日志：对齐 网关 UserLogsView —— 每行展示缩略图、模型、清晰度·比例、
  // 状态（成功/失败/生成中）、prompt（点击复制）、时间、扣费 cost。数据源 /admin/api/logs?source=user。
  function renderHistory(items = state.creditHistory || [], total = state.creditHistoryTotal || 0) {
    if (!els.historyList) return;
    if (!state.key) { els.historyList.innerHTML = '<p class="muted-text">登录后查看使用日志。</p>'; return; }
    const pageItems = Array.isArray(items) ? items : [];
    state.creditHistory = pageItems;
    state.creditHistoryTotal = Math.max(0, Number(total || 0));
    if (!state.creditHistoryTotal) { els.historyList.innerHTML = '<p class="muted-text">暂无使用日志。</p>'; return; }
    const pageSize = Math.max(1, Number(state.creditHistoryPageSize || 10));
    const totalPages = Math.max(1, Math.ceil(state.creditHistoryTotal / pageSize));
    state.creditHistoryPage = Math.min(Math.max(1, Number(state.creditHistoryPage || 1)), totalPages);
    // 网关 /admin/api/logs 的一行 = 一次生成：{ts,kind,status,model,prompt,cost,error,ratio,resolution,file}
    const rows = pageItems.map((x, i) => {
      const idx = i;                            // 用于 data-copy-prompt 回查当前页 prompt
      const cost = Number(x.cost || 0);
      const statusLabel = x.status === "success" ? "成功" : (x.status === "failed" ? "失败" : (x.status === "rejected" ? "已拦截" : (x.status === "pending" ? "生成中" : (x.status || ""))));
      const statusColor = x.status === "success" ? "#1f9d55" : (x.status === "failed" ? "#c0392b" : (x.status === "rejected" ? "#0284c7" : "#b26a00"));
      const kindLabel = x.kind === "video" ? "视频" : "图片";
      const spec = [x.resolution, x.ratio].filter(Boolean).join(" · ");
      const file = x.file ? String(x.file).replace(/\\/g, "/") : "";
      const hasThumb = x.status === "success" && !!file;
      const thumb = hasThumb ? `/images/${file}.thumb.jpg` : "";
      const full = hasThumb ? `/images/${file}` : "";
      const t = x.ts ? new Date(Number(x.ts) * 1000) : null;
      const timeStr = t && !Number.isNaN(t.getTime()) ? t.toLocaleString() : "";
      const promptText = String(x.prompt || "");
      const errText = zhError(String(x.error || ""));
      // 缩略图（成功且有文件）；.thumb.jpg 不存在时 onerror 回退原图。其它状态显示占位块。
      const media = hasThumb
        ? `<img src="${escapeHtml(thumb)}" data-log-full="${escapeHtml(full)}" loading="lazy" alt="" onerror="this.onerror=null;this.src='${escapeHtml(full)}'" style="width:56px;height:56px;object-fit:cover;border-radius:8px;flex:0 0 auto;cursor:zoom-in;background:#8882"/>`
        : `<div style="width:56px;height:56px;border-radius:8px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;background:#8882;color:#8a94a2;font-size:11px">${x.status === "pending" ? "生成中" : (x.status === "failed" ? "失败" : kindLabel)}</div>`;
      // 失败行显示错误；否则显示 prompt（点击复制）。
      const body = ((x.status === "failed" || x.status === "rejected") && errText)
        ? `<p style="margin:2px 0;color:#c0392b;font-size:12px;line-height:1.5;word-break:break-word">${escapeHtml(errText.slice(0, 160))}</p>`
        : (promptText ? `<p data-copy-prompt="${idx}" title="点击复制提示词" style="margin:2px 0;font-size:12px;line-height:1.5;word-break:break-word;cursor:pointer;color:#334155">${escapeHtml(promptText.slice(0, 160))}</p>` : "");
      return `<div class="history-item log-item" style="display:flex;gap:10px;align-items:flex-start">${media}<div style="flex:1;min-width:0"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><strong style="font-size:13px">${escapeHtml(x.model || "生成")} · ${kindLabel}${spec ? " · " + escapeHtml(spec) : ""}</strong><span style="font-size:12px;color:${statusColor};flex:0 0 auto">${escapeHtml(statusLabel)}</span></div>${body}<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#8a94a2;margin-top:2px"><span>${escapeHtml(timeStr)}</span><span>${x.status === "failed" ? "已退款" : (x.status === "rejected" ? "未扣费" : (cost > 0 ? "扣费 " + escapeHtml(cost) + " 积分" : ""))}</span></div></div></div>`;
    }).join("");
    const pager = `<div class="history-pager"><span>每页 ${pageSize} 条，共 ${state.creditHistoryTotal} 条，第 ${state.creditHistoryPage}/${totalPages} 页</span><div><button type="button" data-history-page="prev" ${state.creditHistoryPage <= 1 ? "disabled" : ""}>上一页</button><button type="button" data-history-page="next" ${state.creditHistoryPage >= totalPages ? "disabled" : ""}>下一页</button></div></div>`;
    els.historyList.innerHTML = rows + pager;
    els.historyList.querySelectorAll("[data-history-page]").forEach(btn => {
      btn.onclick = () => {
        const action = btn.getAttribute("data-history-page");
        void loadCreditHistory(state.creditHistoryPage + (action === "next" ? 1 : -1));
      };
    });
    // prompt 点击复制
    els.historyList.querySelectorAll("[data-copy-prompt]").forEach(el => {
      el.onclick = async () => {
        const p = (state.creditHistory || [])[Number(el.getAttribute("data-copy-prompt"))]?.prompt || "";
        if (!p) return;
        const ok = await copyText(p);
        showToast(ok ? "提示词已复制" : "复制失败", ok ? "ok" : "error");
      };
    });
    // 缩略图点击放大
    els.historyList.querySelectorAll("img[data-log-full]").forEach(img => {
      img.onclick = () => showSimpleLightbox(img.getAttribute("data-log-full"));
    });
  }

  async function loadCreditHistory(page = 1) {
    if (!els.historyList || !state.key) { renderHistory([]); return; }
    const pageSize = Math.max(1, Number(state.creditHistoryPageSize || 10));
    const wantPage = typeof page === "number" ? Math.max(1, page) : 1;
    try {
      els.historyList.innerHTML = '<p class="muted-text">加载中...</p>';
      // 使用记录 = 网关 生成日志（按 token 自动作用域到当前用户）。source=user 只看门户生成，不含 API。
      const offset = (wantPage - 1) * pageSize;
      const data = await api(`/admin/api/logs?limit=${pageSize}&offset=${offset}&source=user`, { headers: authHeaders() });
      state.creditHistoryPage = wantPage;
      renderHistory(data.data || [], data.total ?? 0);
    } catch (e) {
      els.historyList.innerHTML = `<p class="message error">${escapeHtml(e.message || String(e))}</p>`;
    }
  }

  // 入账流水类型 → 中文渠道名。对应后端 CreditLog.Type(recharge|redeem|gift|admin|order)。
  const RECHARGE_TYPE_LABELS = {
    recharge: "后台充值",
    redeem: "兑换码",
    gift: "赠送",
    admin: "管理员调整",
    order: "支付到账",
  };

  function rechargeChannel(row) {
    const type = String(row?.type || "");
    return RECHARGE_TYPE_LABELS[type] || row?.title || "积分入账";
  }

  // 渲染当前页(服务端分页)。state.rechargeHistory = 当页数据,state.rechargeHistoryTotal = 总条数。
  function renderRechargeHistory() {
    if (!els.rechargeHistoryList) return;
    if (!state.key) { els.rechargeHistoryList.innerHTML = '<p class="muted-text">登录后查看充值记录。</p>'; return; }
    const pageItems = Array.isArray(state.rechargeHistory) ? state.rechargeHistory : [];
    const total = Number(state.rechargeHistoryTotal || 0);
    if (!total) { els.rechargeHistoryList.innerHTML = '<p class="muted-text">暂无入账记录（充值 / 兑换 / 赠送 / 到账）。</p>'; return; }
    const pageSize = Math.max(1, Number(state.rechargeHistoryPageSize || 10));
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const curPage = Math.min(Math.max(1, Number(state.rechargeHistoryPage || 1)), totalPages);
    const rows = pageItems.map(x => {
      const change = Number(x.amount || 0);
      const sign = change > 0 ? "+" : "";
      const balance = x.balance_after === null || x.balance_after === undefined ? "-" : x.balance_after;
      return `<div class="history-item recharge-history-item"><div><strong>${escapeHtml(rechargeChannel(x))}</strong><p>${escapeHtml(x.title || "")}</p><span>${escapeHtml(formatCreditTime(x.created_at))}</span></div><div class="history-change ${change >= 0 ? "plus" : "minus"}">${sign}${escapeHtml(change)}</div><div class="history-balance">余额 ${escapeHtml(balance)}</div></div>`;
    }).join("");
    const pager = `<div class="history-pager"><span>每页 ${pageSize} 条，共 ${total} 条，第 ${curPage}/${totalPages} 页</span><div><button type="button" data-recharge-history-page="prev" ${curPage <= 1 ? "disabled" : ""}>上一页</button><button type="button" data-recharge-history-page="next" ${curPage >= totalPages ? "disabled" : ""}>下一页</button></div></div>`;
    els.rechargeHistoryList.innerHTML = rows + pager;
    els.rechargeHistoryList.querySelectorAll("[data-recharge-history-page]").forEach(btn => {
      btn.onclick = () => {
        const action = btn.getAttribute("data-recharge-history-page");
        loadRechargeHistory(curPage + (action === "next" ? 1 : -1));
      };
    });
  }

  async function loadRechargeHistory(page = 1) {
    // 入账记录 = 网关 GET /admin/api/credit-logs(按 session/token 作用域到当前用户,仅入账)。
    if (!els.rechargeHistoryList) return;
    if (!state.key) { els.rechargeHistoryList.innerHTML = '<p class="muted-text">登录后查看充值信息。</p>'; return; }
    const pageSize = Math.max(1, Number(state.rechargeHistoryPageSize || 10));
    const wantPage = Math.max(1, Number(page || 1));
    try {
      els.rechargeHistoryList.innerHTML = '<p class="muted-text">加载中...</p>';
      const data = await api(`/admin/api/credit-logs?page=${wantPage}&page_size=${pageSize}`, { headers: authHeaders() });
      state.rechargeHistory = Array.isArray(data.data) ? data.data : [];
      state.rechargeHistoryTotal = Number(data.total ?? state.rechargeHistory.length);
      state.rechargeHistoryPage = Number(data.page || wantPage);
      renderRechargeHistory();
    } catch (e) {
      els.rechargeHistoryList.innerHTML = `<p class="message error">${escapeHtml(e.message || String(e))}</p>`;
    }
  }

  function setRedeemMessage(text, type = "") {
    if (!els.redeemMessage) return;
    els.redeemMessage.textContent = text || "";
    els.redeemMessage.className = `message ${type}`;
  }

  async function redeemCode() {
    if (!state.key) { els.loginDialog.showModal(); return; }
    const code = (els.redeemCodeInput?.value || "").trim();
    if (!code) { setRedeemMessage("请输入兑换码", "error"); return; }
    if (els.redeemBtn) els.redeemBtn.disabled = true;
    try {
      // 网关：POST /admin/api/auth/redeem-cdk {code} → { ok, amount, credits(新余额) }
      const data = await api("/admin/api/auth/redeem-cdk", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ code }),
      });
      if (state.identity && data.credits != null) state.identity.credits = data.credits;
      else void refreshMe();
      if (state.identity?.id) localStorage.setItem("ai_user_id", state.identity.id);
      if (els.redeemCodeInput) els.redeemCodeInput.value = "";
      updateAuthUI();
      void loadCreditHistory();
      void loadRechargeHistory();
      const points = Number(data.amount || 0);
      setRedeemMessage(`兑换成功，增加 ${points} 积分`, "ok");
      void showCenterConfirm({
        title: "兑换成功",
        message: `已成功兑换，当前增加 ${points} 积分。`,
        confirmText: "知道了",
        cancelText: "关闭",
      });
      setMessage("积分充值成功", "ok");
    } catch (e) {
      setRedeemMessage(e.message || String(e), "error");
    } finally {
      if (els.redeemBtn) els.redeemBtn.disabled = false;
    }
  }

  function imageSrc(img) { return img.url || (img.b64_json ? `data:image/png;base64,${img.b64_json}` : ""); }
  function installImageCardActionsStyle() {
    if (document.getElementById("imageCardActionsStyle")) return;
    const style = document.createElement("style");
    style.id = "imageCardActionsStyle";
    style.textContent = `
      .image-card-actions{position:absolute;top:8px;right:8px;z-index:3;display:flex;gap:5px;opacity:0;transform:translateY(-3px);transition:opacity .16s ease,transform .16s ease}
      .image-card:hover .image-card-actions,.image-card:focus-within .image-card-actions{opacity:1;transform:translateY(0)}
      .image-card-action{width:30px;height:30px;padding:0;border:1px solid rgba(255,255,255,.2);border-radius:7px;background:rgba(17,24,39,.72);color:#fff;display:grid;place-items:center;font:700 17px/1 system-ui;text-decoration:none;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2);backdrop-filter:blur(4px)}
      .image-card-action:hover{background:rgba(17,24,39,.9);color:#fff}.image-card-action.danger:hover{background:rgba(220,38,38,.9)}
      .output-list.select-mode .image-card-actions{display:none}
      @media(hover:none),(pointer:coarse){.image-card-actions{opacity:1;transform:none}.image-card-action{width:32px;height:32px}}
    `;
    document.head.appendChild(style);
  }
  function imageCardActions(src) {
    const safe = escapeHtml(src);
    return `<div class="image-card-actions"><button class="image-card-action" type="button" data-image-action="copy" title="复制图片" aria-label="复制图片">&#10697;</button><a class="image-card-action" data-image-action="download" href="${safe}" download="ai-image.png" title="下载" aria-label="下载">&#8595;</a><button class="image-card-action" type="button" data-image-action="reference" title="作为参考图" aria-label="作为参考图">+</button><button class="image-card-action danger" type="button" data-image-action="delete" title="删除" aria-label="删除">&times;</button></div>`;
  }
  async function copyGeneratedImage(src) {
    try {
      const blob = await (await fetch(src, { credentials: "same-origin" })).blob();
      const png = blob.type === "image/png" ? blob : await new Promise((resolve, reject) => {
        createImageBitmap(blob).then(bitmap => {
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          canvas.getContext("2d").drawImage(bitmap, 0, 0);
          canvas.toBlob(out => out ? resolve(out) : reject(new Error("PNG conversion failed")), "image/png");
        }).catch(reject);
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      showToast("图片已复制", "ok");
    } catch { showToast("复制失败，请使用下载按钮", "error"); }
  }
  async function useGeneratedImageAsReference(src) {
    try {
      const response = await fetch(src, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const ext = ((blob.type || "image/png").split("/")[1] || "png").split("+")[0];
      setMode("image");
      const added = await addReferenceFiles([new File([blob], `reference-${Date.now()}.${ext}`, { type: blob.type || "image/png" })]);
      if (added > 0) { showToast("已加入参考图", "ok"); els.imageUploadBox.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
      else showToast("参考图已存在或已达上限", "error");
    } catch { showToast("加入参考图失败", "error"); }
  }
  function generatedFileKey(src) {
    try {
      const path = new URL(src, location.origin).pathname;
      const marker = "/images/";
      const pos = path.indexOf(marker);
      return pos >= 0 ? decodeURIComponent(path.slice(pos + marker.length)) : "";
    } catch { return ""; }
  }
  function removeGeneratedImageLocally(src) {
    for (const task of state.tasks) {
      if (task.mode === "video") continue;
      task.images = (task.images || []).filter(img => safeImageSrc(imageSrc(img)) !== src);
    }
    state.tasks = state.tasks.filter(task => task.mode === "video" || (task.images || []).length);
    state.selected.delete(src);
    saveTasks(); render();
  }
  async function deleteGeneratedImage(src) {
    if (!confirm("确定删除这个作品？删除后不可恢复")) return;
    const file = generatedFileKey(src);
    try {
      if (file) await api(`/admin/api/my-files?file=${encodeURIComponent(file)}`, { method: "DELETE", headers: authHeaders() });
      removeGeneratedImageLocally(src);
      showToast("已删除", "ok");
    } catch (e) { showToast(e.message || "删除失败", "error"); }
  }
  function taskResultImages(task, taskId) {
    return (Array.isArray(task?.data) ? task.data : [])
      .filter(item => item && (item.url || item.b64_json))
      .map((item, index) => ({
        status: "success",
        taskId,
        resultIndex: index,
        b64_json: item.b64_json,
        url: item.url,
        revised_prompt: item.revised_prompt,
        message: "",
      }));
  }
  function applyTaskSuccessImages(localTask, target, task, taskId) {
    const results = taskResultImages(task, taskId);
    if (!results.length) {
      Object.assign(target, { status: "error", error: "未返回图片数据", message: "" });
      return;
    }
    const index = localTask.images.indexOf(target);
    const existing = new Set(localTask.images
      .filter(img => img.taskId === taskId && img !== target)
      .map(img => `${img.resultIndex ?? 0}:${img.url || img.b64_json || ""}`));
    Object.assign(target, results[0]);
    const extras = [];
    for (const result of results.slice(1)) {
      // 被剥掉大图数据的旧位置（落盘时去掉了 b64）：按 resultIndex 原位补回，避免重复插入
      const stripped = localTask.images.find(img => img.taskId === taskId && img !== target
        && !img.url && !img.b64_json && (img.resultIndex ?? 0) === (result.resultIndex ?? 0));
      if (stripped) { Object.assign(stripped, result); continue; }
      if (!existing.has(`${result.resultIndex ?? 0}:${result.url || result.b64_json || ""}`)) extras.push(result);
    }
    if (extras.length) localTask.images.splice(index + 1, 0, ...extras);
  }
  function safeImageSrc(src) {
    const value = String(src || "").trim();
    if (!value) return "";
    if (value.startsWith("data:image/")) return value.replace(/["'<>]/g, "");
    try {
      const u = new URL(value, location.origin);
      if (!["http:", "https:"].includes(u.protocol)) return "";
      return u.href;
    } catch {
      return value.startsWith("/") ? value.replace(/["'<>]/g, "") : "";
    }
  }
  function escapeHtml(str) { return String(str ?? "").replace(/[&<>'"]/g, s => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[s])); }


  const view = { scale: 1, rotate: 0, x: 0, y: 0, dragging: false, startX: 0, startY: 0, baseX: 0, baseY: 0, images: [], index: 0 };
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function applyImageView() {
    els.lightboxImg.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale}) rotate(${view.rotate}deg)`;
  }
  function resetImageView() {
    view.scale = 1; view.rotate = 0; view.x = 0; view.y = 0; view.dragging = false;
    applyImageView();
  }
  function zoomImage(delta, originEvent) {
    const previous = view.scale;
    view.scale = clamp(Number((view.scale + delta).toFixed(2)), 0.2, 6);
    if (view.scale === 1) { view.x = 0; view.y = 0; }
    if (originEvent && previous !== view.scale && view.scale > 1) {
      const rect = els.lightboxImg.getBoundingClientRect();
      const cx = originEvent.clientX - (rect.left + rect.width / 2);
      const cy = originEvent.clientY - (rect.top + rect.height / 2);
      const ratio = view.scale / previous - 1;
      view.x -= cx * ratio * 0.35;
      view.y -= cy * ratio * 0.35;
    }
    applyImageView();
  }
  function collectPreviewImages() {
    return Array.from(document.querySelectorAll('img[data-preview]')).map(img => img.dataset.preview).filter(Boolean);
  }
  function showLightboxImage(index) {
    if (!view.images.length) return;
    view.index = (index + view.images.length) % view.images.length;
    const src = view.images[view.index];
    resetImageView();
    els.lightboxImg.src = src;
    els.downloadLightbox.href = src;
    const single = view.images.length <= 1;
    els.prevImageBtn.classList.toggle("hidden", single);
    els.nextImageBtn.classList.toggle("hidden", single);
  }
  function openLightbox(src) {
    view.images = collectPreviewImages();
    view.index = Math.max(0, view.images.indexOf(src));
    if (!view.images.includes(src)) { view.images = [src]; view.index = 0; }
    els.lightbox.classList.remove("hidden");
    showLightboxImage(view.index);
  }
  function switchLightbox(delta) {
    if (els.lightbox.classList.contains("hidden") || view.images.length <= 1) return;
    showLightboxImage(view.index + delta);
  }
  function closeLightbox() {
    els.lightbox.classList.add("hidden");
    els.lightboxImg.src = "";
  }

  // 后端内部错误串（英文）→ 中文，用于日志/错误展示。命中就整句替换，否则原样返回。
  function zhError(text) {
    const t = String(text || "");
    const l = t.toLowerCase();
    const map = [
      ["insufficient credits", "积分不足"],
      ["no provider account", "暂无可用出图账号，请联系管理员配置"],
      ["provider quota exhausted", "上游额度已用尽，请稍后再试"],
      ["provider token invalid", "出图账号令牌失效或已过期"],
      ["prompt contains banned", "提示词包含违规内容"],
      ["unsupported or unpriced", "该模型不支持所选参数或清晰度"],
      ["unknown model", "未知模型"],
      ["reference image too large", "参考图太大，请压缩后重试"],
      ["temporarily unavailable", "上游暂时不可用，请稍后重试"],
    ];
    for (const [en, zh] of map) { if (l.includes(en)) return zh; }
    return t;
  }

  // 提示词违规/内容策略类错误：重试也没用（换多少次号都会被拒），失败自动重试要跳过这类。
  function isViolationError(msg) {
    return /content[_ ]?policy|policy_violation|image_unsafe|\bunsafe\b|banned|prohibited|not allowed|safety|违规|违禁|拒绝|无法生成|内容策略|敏感/i.test(String(msg || ""));
  }

  function explainError(raw) {
    const text = String(raw || "生成失败");
    const lower = text.toLowerCase();
    if (lower.includes("no available image quota")) {
      return {
        title: "账号池没有可用生图额度",
        detail: "后端已收到请求，但当前账号池上游确认没有可用图片额度，或本地额度缓存已失真。请到后台刷新账号池/更换可用账号后再试。",
        raw: text,
      };
    }
    if (text.includes("生图超时") || lower.includes("timeout")) {
      return {
        title: "上游生图超时",
        detail: "请求已提交到上游，但长时间没有拿到结果。常见原因是代理慢、账号被限流、上游队列拥堵或账号状态异常。",
        raw: text,
      };
    }
    if (lower.includes("content_policy") || lower.includes("policy") || text.includes("无法生成") || text.includes("拒绝")) {
      return {
        title: "上游拒绝了这个提示词",
        detail: "这不一定代表前端错误，是上游模型/账号侧的内容策略判断。可以换更中性的描述重试。",
        raw: text,
      };
    }
    if (lower.includes("connection") || text.includes("连接") || text.includes("proxy") || text.includes("代理")) {
      return {
        title: "上游连接失败",
        detail: "后端连接上游失败，通常和代理、网络或账号会话有关。请检查后台代理配置和账号可用性。",
        raw: text,
      };
    }
    if (lower.includes("401") || lower.includes("unauthorized") || text.includes("密钥")) {
      return {
        title: "登录状态已失效",
        detail: "当前账号密钥无效或登录已过期。请退出后重新登录，再尝试生成。",
        raw: text,
      };
    }
    if (lower.includes("insufficient credits") || text.includes("积分不足")) {
      return {
        title: "积分不足",
        detail: "你的积分余额不足以支付这次生成。请充值或用兑换码增加积分后再试（右上角「充值」）。",
        raw: text,
      };
    }
    return { title: "生成失败", detail: zhError(text), raw: text };
  }

  function renderError(err) {
    const info = explainError(err);
    return `<div class="error-box"><strong>${escapeHtml(info.title)}</strong><small>${escapeHtml(info.detail)}</small><details><summary>查看原始错误</summary><pre>${escapeHtml(info.raw)}</pre></details></div>`;
  }

  function renderVideoTask(task) {
    const v = task.video || {};
    let body;
    if (v.status === "success" && v.url) {
      body = `<div class="video-card"><video src="${escapeHtml(v.url)}" controls playsinline preload="metadata"></video><a class="download" href="${escapeHtml(v.url)}" download="ai-video.mp4">下载</a></div>`;
    } else if (v.status === "error") {
      body = `<div class="video-card">${renderError(v.error)}</div>`;
    } else {
      body = `<div class="video-card"><div class="loading-box"><div class="spinner"></div><span>${escapeHtml(v.message || "生成中...")}</span></div></div>`;
    }
    return `<article class="output-item"><div class="output-meta"><span>${escapeHtml(task.size || "")} · ${escapeHtml(task.model)} • (${escapeHtml(task.creditCost)}积分) • 视频</span><span>${new Date(task.createdAt).toLocaleString()}</span></div><p class="output-prompt">${escapeHtml(task.prompt)}</p><div class="image-grid">${body}</div></article>`;
  }

  function render() {
    if (!state.tasks.length) {
      els.output.className = "output-list empty";
      els.output.innerHTML = `<div class="empty-state"><div class="empty-icon">✦</div><p>还没有图片，输入提示词后开始生成。</p></div>`;
      return;
    }
    els.output.className = state.selectMode ? "output-list select-mode" : "output-list";
    els.output.innerHTML = state.tasks.map(task => {
      if (task.mode === "video") return renderVideoTask(task);
      const cards = task.images.map(img => {
        if (img.status === "loading") {
          const tip = img.message || "正在等待上游返回结果...";
          return `<div class="image-card"><div class="loading-box"><div class="spinner"></div><span>${escapeHtml(tip)}</span></div></div>`;
        }
        if (img.status === "error") return `<div class="image-card">${renderError(img.error)}</div>`;
        const src = safeImageSrc(imageSrc(img));
        if (!src) return `<div class="image-card"><div class="loading-box"><span>图片已过期：大图不在本机保存，最近的任务会自动从服务器恢复</span></div></div>`;
        // 选择模式：卡片可勾选（以 src 作为选中标识），已选加勾与高亮
        const isSel = state.selected.has(src);
        const checkMark = state.selectMode
          ? `<span class="select-check${isSel ? " on" : ""}" aria-hidden="true">${isSel ? "✓" : ""}</span>`
          : "";
        return `<div class="image-card${state.selectMode && isSel ? " selected" : ""}" data-src="${escapeHtml(src)}"><img src="${escapeHtml(src)}" data-preview="${escapeHtml(src)}" alt="result"/>${checkMark}${imageCardActions(src)}</div>`;
      }).join("");
      return `<article class="output-item"><div class="output-meta"><span>${escapeHtml(task.size || "比例：自动")} · ${escapeHtml(task.model)} • (${escapeHtml(task.creditCost || creditCostPerImage(task.quality || "low"))}积分) • ${escapeHtml(task.qualityLabel || "默认")} • ${escapeHtml(task.modeLabel || (task.mode === "image" ? "图生图" : "文生图"))}</span><span>${new Date(task.createdAt).toLocaleString()}</span></div><p class="output-prompt">${escapeHtml(task.prompt)}</p><div class="image-grid">${cards}</div></article>`;
    }).join("");
  }

  async function api(path, options = {}) {
    const res = await fetch(path, options);
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const detail = data?.detail?.error || data?.detail || data?.error || data?.message || `请求失败 ${res.status}`;
      const error = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function creditCostPerImage(quality) {
    const q = String(quality || "low").toLowerCase();
    return Number(state.costs[q] ?? state.costs.low ?? 1) || 0;
  }
  function refreshQualityOptions() {
    // 网关 各档价格是后端按模型算的，前端拿不到逐档单价，只给清晰度语义标签（不写死积分数）。
    if (!els.quality) return;
    const labels = { low: "默认 1K", medium: "高清 2K", high: "超清 4K" };
    Array.from(els.quality.options || []).forEach(opt => { if (labels[opt.value]) opt.textContent = labels[opt.value]; });
  }
  async function loadPricing() {
    // 网关 无 /api/public/pricing。购买(兑换码)链接复用后台「联系我们」的 shop 字段:
    // GET /admin/api/site → contact.shop（后台可配）。设了就显示「立即购买」按钮跳过去。
    try {
      const site = await api("/admin/api/site");
      state.purchaseUrl = String(site?.contact?.shop || "").trim();
    } catch { /* 站点配置拿不到就不显示购买按钮 */ }
    updatePurchaseButton();
    refreshQualityOptions();
    updateCostHint();
  }
  // 当前选中的 image 模型（带 ratios/resolutions 元数据）
  function currentModel() {
    const v = els.model?.value || "";
    // 下拉 value 是别名(有别名时)或 id — 两种都要能匹配回代表配置。
    return (state.imageModels || []).find(m => (m.alias || m.id) === v);
  }
  function currentVideoModel() {
    const value = els.videoModel?.value || "";
    return (state.videoModels || []).find(m => (m.alias || m.id) === value);
  }
  async function loadImageModels() {
    // 只显示 admin 实际配置的模型（managed-models），对齐 网关 自己的前端——
    // 有配置什么就显示什么,不再列全量目录。
    // GET /admin/api/managed-models → { data:[{id,name,alias,type,enabled,ratios,resolutions,prices,...}] }
    try {
      const data = await api("/admin/api/managed-models");
      const all = Array.isArray(data.data) ? data.data : [];
      const imgs = all.filter(m => m.id && m.enabled !== false && (m.type || m.kind || "image") === "image");
      // 合并 failover 组:一个逻辑模型可由多个后端配置共用同一别名(如 nano-banana-2 由
      // runway/adobe 两个后端提供)。managed-models 已按权重降序返回,故按显示名去重、保留
      // 首个(=最高权重)代表整组;下拉只显示一次。
      const seen = new Set();
      state.imageModels = [];
      for (const m of imgs) {
        const label = m.alias || m.name || m.id;
        if (seen.has(label)) continue;
        seen.add(label);
        state.imageModels.push(m);
      }
      if (!els.model || !state.imageModels.length) return;
      // option 的 value:有别名就用别名(提交后后端按别名解析整组并按权重降级),否则用 id。
      els.model.innerHTML = state.imageModels.map(m => `<option value="${escapeHtml(m.alias || m.id)}">${escapeHtml(m.alias || m.name || m.id)}</option>`).join("");
      applyModelUi();
    } catch { /* 模型拿不到就沿用 index.html 默认项 */ }
  }
  function applyModelUi() {
    // 按当前模型实际支持的 resolution 过滤清晰度档:模型只声明 1K 就只留「默认」,
    // 并隐藏整个清晰度控件(无从选择)。生成时 pickResolution 仍会兜底。
    const QMAP = { low: "1K", medium: "2K", high: "4K" };
    const reslist = (currentModel()?.resolutions || []).map(r => String(r).toUpperCase());
    const qc = els.quality && els.quality.closest(".control");
    if (els.quality) {
      let firstVisible = null, visible = 0;
      Array.from(els.quality.options || []).forEach(opt => {
        const res = QMAP[String(opt.value).toLowerCase()] || "1K";
        const ok = !reslist.length || reslist.includes(res);
        opt.hidden = !ok;
        if (ok) { visible++; if (!firstVisible) firstVisible = opt.value; }
      });
      const curRes = QMAP[String(els.quality.value).toLowerCase()] || "1K";
      if (reslist.length && !reslist.includes(curRes) && firstVisible) els.quality.value = firstVisible;
      // 保留清晰度选择器可见,只隐藏模型不支持的档(不整个删掉)。
      if (qc) qc.classList.remove("hidden");
    }
    refreshQualityOptions();
    updateCostHint();
  }
  // 清晰度档 → 网关 resolution（1K/2K/4K，规范档位）；模型不支持该档则回退到它的首个可用档。
  function pickResolution(quality) {
    const q = String(quality || "low").toLowerCase();
    const want = q === "high" ? "4K" : (q === "medium" ? "2K" : "1K");
    const list = currentModel()?.resolutions || [];
    if (!list.length) return want;
    return list.includes(want) ? want : list[0];
  }
  // 比例 → 网关 ratio；空=自动时取模型首选（优先 1:1）；模型未声明 ratios 则原样透传。
  function pickRatio(size) {
    const want = String(size || "").trim();
    const list = currentModel()?.ratios || [];
    if (want) { if (!list.length || list.includes(want)) return want; }
    if (list.length) return list.includes("1:1") ? "1:1" : list[0];
    return want; // 空且模型未声明 ratios → 让后端用默认
  }
  async function loadAdminUrl() {
    // 网关 后台是同源 Vue SPA；无 /api/public/admin-url 接口。默认 /admin，登录态经 gw_token 复用。
    state.adminUrl = state.adminUrl && state.adminUrl !== "/accounts/" ? state.adminUrl : "/admin";
    updateAuthUI();
  }
  function updatePurchaseButton() {
    if (!els.purchaseBtn) return;
    const url = String(state.purchaseUrl || "").trim();
    els.purchaseBtn.classList.toggle("hidden", !url);
    if (url) els.purchaseBtn.href = url;
  }
  function currentGenerationCost() {
    if (state.mode === "video") {
      const model = currentVideoModel();
      const resolution = String(els.vidResolution?.value || "");
      const duration = String(els.vidSeconds?.value || "");
      const prices = model?.prices || {};
      const durationPrices = model?.duration_prices || {};
      return (Number(prices[resolution]) || 0) + (Number(durationPrices[duration]) || 0);
    }
    const count = Math.max(1, Math.min(4, Number(els.count?.value) || 1));
    // 模型逐档单价在 managed-models 的 prices 里(如 {"1K":5,"2K":8,"4K":15}),按清晰度档取。
    const m = currentModel();
    const QMAP = { low: "1K", medium: "2K", high: "4K" };
    const tier = QMAP[String(els.quality?.value || "low").toLowerCase()] || "1K";
    let prices = (m && m.prices) || {};
    if (typeof prices === "string") { try { prices = JSON.parse(prices); } catch { prices = {}; } }
    let per = Number(prices[tier]);
    if (!(per > 0)) per = Number(m && m.price) || creditCostPerImage(els.quality?.value || "low");
    return (Number(per) || 0) * count;
  }
  function upstreamQuality(value) {
    // 这条 ChatGPT 图片链路里 quality/size 会被写进提示词，而不是真正的像素开关。
    // 1K 要恢复改版前效果：完全不传 quality，避免出现 “low/auto” 降质提示。
    const q = String(value || "low").toLowerCase();
    if (q === "medium") return "medium";
    if (q === "high") return "high";
    return "";
  }
  function outputSizeForRatio(ratio) {
    // 保持改版前行为：默认不传 size。用户选择比例时仍传 1:1/16:9 等比例提示。
    return String(ratio || "").trim();
  }
  function displaySizeLabel(ratio) {
    const value = String(ratio || "").trim();
    const labels = { "": "比例：自动", "1:1": "比例：方形 1:1", "3:4": "比例：竖版 3:4", "9:16": "比例：故事版 9:16", "4:3": "比例：横版 4:3", "16:9": "比例：宽屏 16:9" };
    return labels[value] || `比例：${value}`;
  }

  function currentQualityLabel() {
    if (state.mode === "video") return (els.vidResolution?.value || "720p");
    const value = els.quality?.value || "low";
    if (value === "medium") return "高清2K";
    if (value === "high") return "超清4K";
    return "默认1K";
  }
  function currentModeLabel() { return state.mode === "video" ? "视频" : (state.mode === "image" ? "图生图" : "文生图"); }
  async function loadVideoConfig() {
    try {
      const data = await api("/admin/api/managed-models");
      const all = Array.isArray(data.data) ? data.data : [];
      state.videoModels = all.filter(m => m.id && m.enabled !== false && (m.type || m.kind) === "video");
      if (!state.videoModels.length) throw new Error("没有已启用的视频模型");
      els.videoModel.innerHTML = state.videoModels.map(m => `<option value="${escapeHtml(m.alias || m.id)}">${escapeHtml(m.alias || m.name || m.id)}</option>`).join("");
      state.videoConfig.enabled = true;
      els.videoModeBtn?.classList.remove("hidden");
      applyVideoModelUi();
    } catch {
      state.videoConfig.enabled = false;
      els.videoModeBtn?.classList.add("hidden");
      if (state.mode === "video") setMode("text");
    }
  }
  function applyVideoModelUi() {
    const model = currentVideoModel();
    if (!model) return;
    const fill = (select, values) => {
      if (!select) return;
      const previous = select.value;
      select.innerHTML = (values || []).map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
      if ((values || []).includes(previous)) select.value = previous;
    };
    fill(els.vidSeconds, model.durations || []);
    fill(els.vidResolution, model.resolutions || []);
    fill(els.vidOrient, model.ratios || []);
    const maxRefs = Math.max(0, Number(model.max_reference_images || 0));
    if (state.referenceFiles.length > maxRefs) {
      state.referenceFiles = state.referenceFiles.slice(0, maxRefs);
      renderReferences();
    }
    els.vidPreset?.closest(".control")?.classList.add("hidden");
    refreshUploadBox();
    updateCostHint();
  }
  async function loadAnnouncement() {
    // 网关：GET /admin/api/announcement → { content, version, seen }（需登录态）。
    // 未读过这版(!seen)且有内容 -> 居中弹一次；点"我知道了"或遮罩上报已读 POST /announcement/seen。
    if (!els.announceModal || !els.announceModalBody) return;
    if (!state.key) return;
    try {
      const a = await api("/admin/api/announcement", { headers: authHeaders() });
      if (!a || !a.content || a.seen) return;
      const version = a.version || "";
      if (version && localStorage.getItem("ai_seen_announcement_id") === version) return;
      els.announceModalBody.textContent = a.content;
      els.announceModal.classList.remove("hidden");
      const dismiss = () => {
        els.announceModal.classList.add("hidden");
        try { localStorage.setItem("ai_seen_announcement_id", version); } catch {}
        // 同步上报后端，管理员/多设备下次不再弹
        api("/admin/api/announcement/seen", { method: "POST", headers: authHeaders(), body: JSON.stringify({ version }) }).catch(() => {});
        if (els.announceModalClose) els.announceModalClose.onclick = null;
        els.announceModal.onclick = null;
      };
      if (els.announceModalClose) els.announceModalClose.onclick = dismiss;
      els.announceModal.onclick = (ev) => { if (ev.target === els.announceModal) dismiss(); };
    } catch { /* 拿不到公告就算了 */ }
  }
  function updateCostHint() {
    if (!els.generate) return;
    if (!els.costHint) return;
    if (state.mode === "video") { els.costHint.textContent = `本次需要 ${currentGenerationCost()} 积分`; return; }
    const cost = currentGenerationCost();
    // 跟 2s21 前端一致:显示"本次需要 N 积分"(简短)。拿不到单价的极少情况退回张数提示。
    if (cost > 0) { els.costHint.textContent = `本次需要 ${cost} 积分`; return; }
    const count = Math.max(1, Math.min(4, Number(els.count?.value) || 1));
    els.costHint.textContent = `本次生成 ${count} 张`;
  }

  async function loginWithPassword() {
    const username = (els.loginUsernameInput?.value || "").trim();
    const password = (els.loginPasswordInput?.value || "").trim();
    if (!username || !password) { setAuthInlineMsg("请输入用户名和密码", "error"); throw new Error("请输入用户名和密码"); }
    // 网关：POST /admin/api/auth/login { identifier, password } → { ok, token, user }
    const data = await api("/admin/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // identifier 可为用户名或邮箱；我们的登录框用用户名，直接作为 identifier。
      body: JSON.stringify({ identifier: username, username, password }),
    });
    setSessionToken(data.token || "");
    state.identity = data.user || null;
    state.apiKeyPlain = ""; state.apiKeyInfo = null;
    if (state.identity?.id) localStorage.setItem("ai_user_id", state.identity.id);
    updateAuthUI();
    setAuthInlineMsg("", "");
    els.loginDialog.close();
    setMessage("登录成功", "ok");
    void loadAnnouncement();
  }

  function setAuthTab(tab) {
    const isRegister = tab === "register";
    els.loginTabBtn?.classList.toggle("active", !isRegister);
    els.registerTabBtn?.classList.toggle("active", isRegister);
    els.loginPane?.classList.toggle("hidden", isRegister);
    els.registerPane?.classList.toggle("hidden", !isRegister);
    els.saveKeyBtn?.classList.toggle("hidden", isRegister);
    els.registerSubmitBtn?.classList.toggle("hidden", !isRegister);
    setAuthInlineMsg("", "");
    if (isRegister) void loadCaptcha();
  }

  function setRegisterResult(text, type = "") {
    if (!els.registerResult) return;
    els.registerResult.textContent = text || "";
    els.registerResult.className = `register-result ${type || ""} ${text ? "" : "hidden"}`;
    setAuthInlineMsg("", "");
  }

  async function loadCaptcha() {
    // 算术题验证码:GET /admin/api/auth/captcha → { captcha_id, question:"3 + 5 = ?" }
    // 显示题目文字,用户在下方输入答案;点击题目可刷新。
    if (!els.captchaQuestion) return;
    els.captchaQuestion.textContent = "加载中...";
    try {
      const data = await api("/admin/api/auth/captcha");
      state.captcha.id = data.captcha_id || "";
      const q = (data.question || "").trim();
      if (q) {
        els.captchaQuestion.textContent = q;
        els.captchaQuestion.title = "点击刷新";
        els.captchaQuestion.style.cursor = "pointer";
        els.captchaQuestion.style.userSelect = "none";
        els.captchaQuestion.onclick = () => loadCaptcha();
      } else {
        els.captchaQuestion.textContent = "验证码加载失败，请刷新重试";
      }
      if (els.captchaAnswerInput) els.captchaAnswerInput.value = "";
    } catch (e) {
      els.captchaQuestion.textContent = "验证码加载失败，请刷新重试";
    }
  }

  async function submitRegister() {
    const username = (els.registerUsernameInput?.value || "").trim();
    const password = (els.registerPasswordInput?.value || "").trim();
    const passwordConfirm = (els.registerPasswordConfirmInput?.value || "").trim();
    const name = username;
    const answer = (els.captchaAnswerInput?.value || "").trim();
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) { setRegisterResult("用户名只能包含字母、数字和下划线，长度 3-24 位", "error"); return; }
    if (password.length < 6) { setRegisterResult("密码至少 6 位", "error"); return; }
    if (password !== passwordConfirm) { setRegisterResult("两次输入的密码不一致", "error"); return; }
    if (!answer) { setRegisterResult("请输入验证码答案", "error"); return; }
    if (!state.captcha.id) { setRegisterResult("验证码已失效，请刷新验证码", "error"); await loadCaptcha(); return; }
    if (els.registerSubmitBtn) els.registerSubmitBtn.disabled = true;
    try {
      // 网关（新增接口）：POST /admin/api/auth/register-captcha
      //   { username, password, captcha_id, captcha_answer } → { ok, token, user }
      const data = await api("/admin/api/auth/register-captcha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, captcha_id: state.captcha.id, captcha_answer: answer }),
      });
      const token = data.token || "";
      if (!token) throw new Error("注册成功但没有返回会话");
      setSessionToken(token);
      state.identity = data.user || null;
      state.apiKeyPlain = ""; state.apiKeyInfo = null;
      if (state.identity?.id) localStorage.setItem("ai_user_id", state.identity.id);
      setRegisterResult("注册成功，已自动登录。", "");
      updateAuthUI();
      if (!state.identity) { try { await refreshMe(); } catch {} }
      setMessage("注册并登录成功", "ok");
      showToast("注册并登录成功", "ok");
      void loadAnnouncement();
      setTimeout(() => els.loginDialog?.close(), 900);
    } catch (e) {
      setRegisterResult(e.message || String(e), "error");
      await loadCaptcha();
    } finally {
      if (els.registerSubmitBtn) els.registerSubmitBtn.disabled = false;
    }
  }

  // 参考图 File → 裸 base64（去掉 data:...;base64, 前缀），供 reference_images 数组。
  function refFileToBase64(file) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || "").replace(/^data:[^,]*,/, ""));
      fr.onerror = () => resolve("");
      fr.readAsDataURL(file);
    });
  }
  // 网关：同步 POST /admin/api/generate。文生图/图生图同一端点，靠 reference_images 区分。
  //   请求：{ model, prompt, ratio?, resolution?, reference_images?[base64] }
  //   返回：{ created, data:[{url,b64_json:null}], url, model, provider, kind, elapsed_ms, charged, credits }
  //   —— 同步返回成品图 url（session 源已落盘，b64_json 为 null）。
  async function createOneTask(prompt, model, size, quality, mode, refs) {
    const ratio = pickRatio(size);
    const resolution = pickResolution(quality);
    const payload = { model, prompt };
    if (ratio) payload.ratio = ratio;
    if (resolution) payload.resolution = resolution;
    if (mode === "image") {
      if (!refs || !refs.length) throw new Error("图生图请先上传参考图");
      payload.reference_images = refs;
    }
    return api("/admin/api/generate", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
  }
  // 从 /admin/api/generate 响应里取成品图 url（优先顶层 url，其次 data[0].url）
  function pickGeneratedUrl(res) {
    if (!res) return "";
    if (res.url) return String(res.url);
    const d = Array.isArray(res.data) ? res.data[0] : null;
    if (d && d.url) return String(d.url);
    if (d && d.b64_json) return `data:image/png;base64,${d.b64_json}`;
    return "";
  }

  async function pollTask(localTask, serverTaskId) {
    if (state.polling.has(serverTaskId)) return;
    state.polling.add(serverTaskId);
    const startedAt = Date.now();
    try {
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, i < 2 ? 2500 : 5000));
        const img = localTask.images.find(x => x.taskId === serverTaskId);
        if (img && img.status === "loading") {
          const elapsed = Math.floor((Date.now() - startedAt) / 1000);
          img.message = elapsed > 60 ? `仍在生成中，已等待 ${elapsed} 秒` : "正在生成中...";
          render();
        }
        const data = await api(`/api/image-tasks?ids=${encodeURIComponent(serverTaskId)}`, { headers: { Authorization: `Bearer ${state.key}` } });
        const task = data.items?.[0];
        if (!task) continue;
        const target = localTask.images.find(x => x.taskId === serverTaskId);
        if (!target) return;
        if (task.status === "success") {
          applyTaskSuccessImages(localTask, target, task, serverTaskId);
          setMessage("图片生成成功", "ok");
          void refreshMe();
          void loadCreditHistory();
          saveTasks(); render(); return;
        }
        if (task.status === "error" || task.status === "canceled") {
          Object.assign(target, { status: "error", error: task.error || "生成失败", message: "" });
          setMessage(explainError(target.error).title, "error");
          saveTasks(); render(); return;
        }
      }
      const img = localTask.images.find(x => x.taskId === serverTaskId);
      if (img) Object.assign(img, { status: "error", error: "前端等待超时：任务长时间没有完成，请到后台日志查看上游是否卡住。" });
      saveTasks(); render();
    } catch (e) {
      const img = localTask.images.find(x => x.taskId === serverTaskId);
      if (img) Object.assign(img, { status: "error", error: e.message || String(e) });
      setMessage(explainError(e.message || e).title, "error");
      void refreshMe();
      void loadCreditHistory();
      saveTasks(); render();
    } finally {
      state.polling.delete(serverTaskId);
    }
  }

  function scrollToOutputOnMobile() {
    // 移动端（单列布局）下，创建区在上、结果区在下，提交后自动滚到结果区
    if (!window.matchMedia || !window.matchMedia("(max-width: 860px)").matches) return;
    const panel = document.getElementById("outputPanel");
    if (!panel || panel.classList.contains("page-hidden")) return;
    requestAnimationFrame(() => {
      const offset = 96; // 顶栏 + 横向侧栏的吸顶高度
      const top = panel.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    });
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function generateVideo() {
    const prompt = els.prompt.value.trim();
    if (!prompt) { setMessage("请先输入提示词", "error"); return; }
    let identity = state.identity;
    try { identity = await refreshMe(); } catch {}
    const videoModel = currentVideoModel();
    if (!videoModel) { setMessage("当前没有可用的视频模型", "error"); return; }
    const needCost = currentGenerationCost();
    const remaining = Number(identity?.credits || 0);
    if (remaining < needCost) {
      setMessage("", "");
      await showInsufficientCredits(needCost, remaining);
      return;
    }
    const duration = String(els.vidSeconds?.value || "");
    const resolution = els.vidResolution?.value || "720p";
    const ratio = els.vidOrient?.value || "16:9";
    const maxRefs = Math.max(0, Number(videoModel.max_reference_images || 0));
    const refFiles = maxRefs > 0 ? (state.referenceFiles || []).slice(0, maxRefs) : [];
    const refs = (await Promise.all(refFiles.map(refFileToBase64))).filter(Boolean);
    const model = videoModel.alias || videoModel.id;
    const task = { id: uid(), mode: "video", prompt, model, size: `${resolution} · ${duration}`, creditCost: needCost, qualityLabel: resolution, modeLabel: refs.length ? "图生视频" : "视频", createdAt: Date.now(), video: { status: "loading", taskId: "", progress: 0, message: "视频生成中..." } };
    state.tasks.unshift(task);
    render(); saveTasks(); setMessage("视频任务已提交，正在生成...", "ok"); scrollToOutputOnMobile();
    els.generate.disabled = true;
    try {
      const res = await api("/admin/api/generate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ model, prompt, duration, resolution, ratio, reference_images: refs }),
      });
      const url = String(res.url || (Array.isArray(res.data) && res.data[0]?.url) || "");
      if (!url) throw new Error("后端未返回视频地址");
      task.video = { status: "success", url, progress: 100 };
      if (res.charged != null) task.creditCost = res.charged;
      if (state.identity && res.credits != null) state.identity.credits = res.credits;
      setMessage("视频生成完成", "ok");
      saveTasks(); render(); void refreshMe(); void loadCreditHistory();
    } catch (e) {
      const message = e.message || String(e);
      if (e.status === 402 || isInsufficientCredits(message)) {
        state.tasks = state.tasks.filter(item => item !== task);
        await refreshMe().catch(() => {});
        await showInsufficientCredits(needCost, state.identity?.credits);
        saveTasks(); render();
        return;
      }
      const recoverable = !e.status || e.status >= 500 || /timeout|timed out|failed to fetch|network|524/i.test(message);
      if (recoverable) {
        task.video.message = "连接超时，后台仍在生成，正在自动恢复...";
        saveTasks(); render();
        try {
          await recoverVideoTask(task, message);
        } catch (recoverError) {
          task.video = { status: "error", error: recoverError.message || String(recoverError) };
          setMessage(explainError(task.video.error).title, "error");
          saveTasks(); render();
        }
      } else {
        task.video = { status: "error", error: message };
        setMessage(explainError(message).title, "error");
        saveTasks(); render();
      }
      void refreshMe();
    } finally { els.generate.disabled = false; }
  }

  async function recoverVideoTask(task, submitError = "") {
    const deadline = Date.now() + 12 * 60 * 1000;
    const lookupDeadline = Date.now() + 30000;
    const normalize = value => String(value || "").trim().replace(/\s+/g, " ");
    const wantedPrompt = normalize(task.prompt);
    let found = false;
    while (Date.now() < deadline) {
      let data = null;
      try { data = await api("/admin/api/jobs/mine?source=user", { headers: authHeaders() }); }
      catch { await sleep(4000); continue; }
      const candidates = [data?.pending, data?.latest].filter(Boolean);
      const job = candidates.find(item => {
        if (String(item.kind || "") !== "video") return false;
        const prompt = normalize(item.prompt);
        return !wantedPrompt || !prompt || prompt.includes(wantedPrompt) || wantedPrompt.includes(prompt);
      });
      if (job) {
        found = true;
        task.video.taskId = job.id || task.video.taskId || "";
        const status = String(job.status || "").toLowerCase();
        if (["success", "succeeded", "completed"].includes(status) && job.url) {
          task.video = { status: "success", taskId: job.id || "", url: job.url, progress: 100 };
          if (job.charged != null) task.creditCost = job.charged;
          setMessage("视频生成完成", "ok");
          saveTasks(); render(); void refreshMe(); void loadCreditHistory();
          return;
        }
        if (["failed", "error", "canceled"].includes(status)) throw new Error(job.error || "视频生成失败");
        task.video.message = "后台生成中...";
        saveTasks(); render();
      } else if (!found && Date.now() >= lookupDeadline) {
        throw new Error(submitError || "未找到后台视频任务");
      }
      await sleep(4000);
    }
    throw new Error("视频生成等待超时，请到我的图片查看结果");
  }

  async function generate() {
    if (!state.key) { els.loginDialog.showModal(); return; }
    if (state.mode === "video") { return generateVideo(); }
    const prompt = els.prompt.value.trim();
    if (!prompt) { setMessage("请先输入提示词", "error"); return; }
    const count = Math.max(1, Math.min(4, Number(els.count.value) || 1));
    let identity = state.identity;
    try { identity = await refreshMe(); } catch {}
    const credits = Number(identity?.credits ?? 0);
    const unitCost = currentGenerationCost();
    const needCost = unitCost * count;
    if (identity && credits < needCost) {
      setMessage("", "");
      await showInsufficientCredits(needCost, credits);
      return;
    }
    // 图生图参考图 & 模式在这里快照——入队后用户可能改参数再点生成，队列里的任务不能受影响。
    const mode = state.mode;
    let refs = null;
    if (mode === "image") {
      if (!state.referenceFiles.length) { setMessage("图生图请先上传参考图", "error"); return; }
      refs = (await Promise.all(state.referenceFiles.map(refFileToBase64))).filter(Boolean);
      if (!refs.length) { setMessage("参考图读取失败，请重新上传", "error"); return; }
    }
    const model = els.model.value, size = els.size.value, quality = els.quality.value;
    const localTask = { id: uid(), prompt, mode, model, size: displaySizeLabel(size), quality, creditCost: unitCost, qualityLabel: currentQualityLabel(), modeLabel: currentModeLabel(), createdAt: Date.now(), images: [] };
    state.tasks.unshift(localTask);
    // 入队（非阻塞）：每张一个占位卡 + 一个队列任务；按钮不禁用，用户可继续添加新任务。
    if (!state.genQueue) state.genQueue = [];
    for (let i = 0; i < count; i++) {
      const placeholder = { status: "loading", taskId: "", message: "排队中..." };
      localTask.images.push(placeholder);
      state.genQueue.push({ localTask, placeholder, prompt, model, size, quality, mode, refs, unitCost });
    }
    render(); saveTasks(); setMessage("任务已提交，排队生成中（可继续添加）", "ok");
    scrollToOutputOnMobile();
    processGenQueue(); // 后台按序处理，不阻塞「开始生成」按钮
  }

  // 客户端生成队列：起最多 N 个并发 worker（N=用户并发上限 concurrency_limit），各自从队列取任务
  // 调用同步 /admin/api/generate。网关 新版已允许并发（按并发组上限），撞并发满(429)自动退避重试。
  // 处理期间「开始生成」按钮不禁用，用户可继续把任务加进队列。
  function processGenQueue() {
    const limit = Math.max(1, Math.min(Number(state.identity?.concurrency_limit) || 3, 20));
    state.genWorkers = state.genWorkers || 0;
    while (state.genWorkers < limit && state.genQueue && state.genQueue.length) {
      state.genWorkers++;
      void genWorker();
    }
  }
  function removeQueuedPlaceholder(job) {
    if (!job?.localTask || !job?.placeholder) return;
    job.localTask.images = (job.localTask.images || []).filter(item => item !== job.placeholder);
    if (!job.localTask.images.length) state.tasks = state.tasks.filter(item => item !== job.localTask);
  }
  function clearQueuedForInsufficient() {
    const queued = state.genQueue ? state.genQueue.splice(0) : [];
    queued.forEach(removeQueuedPlaceholder);
  }
  async function genWorker() {
    try {
      while (state.genQueue && state.genQueue.length) {
        const job = state.genQueue.shift();
        const { localTask, placeholder } = job;
        Object.assign(placeholder, { status: "loading", message: "正在生成中..." });
        render();
        let done = false, tries = 0, autoTries = 0;
        while (!done) {
          try {
            const res = await createOneTask(job.prompt, job.model, job.size, job.quality, job.mode, job.refs);
            const url = pickGeneratedUrl(res);
            if (!url) throw new Error("后端未返回图片数据");
            Object.assign(placeholder, { status: "success", url, message: "", revised_prompt: "" });
            if (res.charged != null) localTask.creditCost = res.charged;
            if (state.identity && res.credits != null) { state.identity.credits = res.credits; updateAuthUI(); }
            setMessage("图片生成成功", "ok");
            done = true;
          } catch (err) {
            const message = err.message || String(err);
            if (err.status === 402 || isInsufficientCredits(message)) {
              removeQueuedPlaceholder(job);
              clearQueuedForInsufficient();
              await refreshMe().catch(() => {});
              await showInsufficientCredits(job.unitCost, state.identity?.credits);
              saveTasks(); render();
              done = true;
              continue;
            }
            // 并发满(429)/瞬时冲突 → 退避重试，不算失败
            if (tries < 30 && /429|并发|concurrency|too many|已有正在生成/i.test(message)) {
              tries++;
              Object.assign(placeholder, { status: "loading", message: "并发已满，等待空位..." });
              render();
              await sleep(3000);
              continue;
            }
            // 页面刷新/关闭/跳转把在途 fetch 打断时会抛 TypeError: Failed to fetch，
            // 但后端任务其实仍在生成/已完成——绝不能当成生成失败落盘。留成可恢复的 loading 占位，
            // 下次进入页面由 reconcileInterruptedTasks 从后端日志把成品图找回并回填。
            if (state.unloading) {
              Object.assign(placeholder, { status: "loading", recover: true, message: "连接已断开，重新进入页面会自动恢复…" });
              saveTasks();
              return;
            }
            // 非卸载场景下的瞬时网络抖动（Failed to fetch/网络错误）：先退避重试几次，别急着判失败。
            if (tries < 6 && /failed to fetch|networkerror|network error|load failed|err_network/i.test(message)) {
              tries++;
              Object.assign(placeholder, { status: "loading", message: "网络波动，正在重试…" });
              render();
              await sleep(3000);
              continue;
            }
            // 用户开启的「失败自动重试」：非违规失败自动重试 N 次（提示词违规不重试，重试也白搭）。
            if (els.autoRetryToggle && els.autoRetryToggle.checked && !isViolationError(message)) {
              const maxAuto = Math.max(1, Math.min(20, parseInt((els.autoRetryCount && els.autoRetryCount.value) || "3", 10) || 3));
              if (autoTries < maxAuto) {
                autoTries++;
                Object.assign(placeholder, { status: "loading", message: `失败重试中 ${autoTries}/${maxAuto}…` });
                render();
                await sleep(2000);
                continue;
              }
            }
            Object.assign(placeholder, { status: "error", error: message, message: "" });
            setMessage(explainError(message).title, "error");
            done = true;
          }
        }
        saveTasks(); render();
      }
    } finally {
      state.genWorkers = Math.max(0, (state.genWorkers || 1) - 1);
      if (state.genWorkers <= 0) { void refreshMe(); void loadCreditHistory(); }
    }
  }


  function resumePendingTasks() {
    // 上次会话在出图中途被刷新/关闭时，同步 /admin/api/generate 的在途 fetch 会被浏览器打断
    // （抛 TypeError: Failed to fetch），但后端任务其实仍在跑/已完成。
    // 旧逻辑把本地 loading 占位一律判成「任务中断/生成失败」，导致后端明明成功、前端却报
    // 「生成失败 / Failed to fetch」——这正是本次修复的根因。
    // 现在改为：不再武断判失败，把图片 loading 占位标成「恢复中」，交给 reconcileInterruptedTasks
    // 去 /admin/api/logs 按 prompt + 时间把成品图找回来回填；实在找不到才给温和提示（不再报失败）。
    if (!state.key) return;
    let __changed = false;
    let __hasPendingImage = false;
    for (const task of state.tasks) {
      if (task.mode === "video") {
        const v = task.video;
        if (v && v.status === "loading") {
          v.message = "正在从服务器恢复视频任务...";
          __changed = true;
          void recoverVideoTask(task, "任务中断且未找到后台结果").catch(err => {
            task.video = { status: "error", error: err.message || String(err) };
            saveTasks(); render();
          });
        }
        continue;
      }
      for (const img of task.images || []) {
        if (img.status === "loading") {
          if (!img.recover || !img.message) { img.recover = true; img.message = "\u6b63\u5728\u4ece\u670d\u52a1\u5668\u6062\u590d\u7ed3\u679c\u2026"; __changed = true; }
          __hasPendingImage = true;
        }
      }
    }
    if (__changed) { saveTasks(); render(); }
    if (__hasPendingImage) void reconcileInterruptedTasks();
  }

  // \u5237\u65b0/\u65ad\u7ebf\u540e\u7684\u81ea\u6108\uff1a\u540c\u6b65 /admin/api/generate \u6ca1\u6709 job id \u53ef\u8f6e\u8be2\uff0c\u4f46\u6210\u54c1\u4f1a\u5199\u8fdb\u540e\u7aef\u751f\u6210\u65e5\u5fd7\u3002
  // \u8fd9\u91cc\u6309 prompt + \u65f6\u95f4\u7a97\u53e3\uff0c\u628a /admin/api/logs \u91cc\u521a\u5b8c\u6210\u7684\u56fe\u56de\u586b\u5230\u672c\u5730\u300c\u6062\u590d\u4e2d\u300d\u5360\u4f4d\uff0c
  // \u4ece\u6839\u4e0a\u907f\u514d\u628a\u300c\u5237\u65b0\u6253\u65ad\u7684\u5728\u9014\u8bf7\u6c42\u300d\u8bef\u663e\u793a\u6210\u300c\u751f\u6210\u5931\u8d25 / Failed to fetch\u300d\u3002
  async function reconcileInterruptedTasks() {
    if (!state.key || state.reconciling) return;
    const pending = () => {
      const out = [];
      for (const task of state.tasks) {
        if (task.mode === "video") continue;
        for (const img of task.images || []) if (img.status === "loading") out.push({ task, img });
      }
      return out;
    };
    if (!pending().length) return;
    state.reconciling = true;
    const norm = (s) => String(s || "").trim().replace(/\s+/g, " ");
    const promptHit = (rowPrompt, taskPrompt) => {
      const a = norm(rowPrompt), b = norm(taskPrompt);
      if (!a || !b) return !b;                 // \u4efb\u52a1\u65e0 prompt\uff08\u6781\u5c11\u89c1\uff09\u65f6\u4e0d\u9760 prompt \u5361
      return a.includes(b) || b.includes(a);   // \u540e\u7aef\u53ef\u80fd\u7ed9 prompt \u8ffd\u52a0\u6e05\u6670\u5ea6/\u6bd4\u4f8b\uff0c\u505a\u53cc\u5411\u5305\u542b\u5339\u914d
    };
    const usedUrls = () => {
      const set = new Set();
      for (const task of state.tasks) for (const img of task.images || []) {
        if (img.status === "success" && img.url) set.add(String(img.url));
      }
      return set;
    };
    try {
      const deadline = Date.now() + 150000;    // \u6700\u591a\u627e\u56de ~2.5 \u5206\u949f
      let round = 0;
      while (Date.now() < deadline) {
        if (!pending().length) break;
        let rows = [];
        try {
          const data = await api("/admin/api/logs?limit=200&source=user", { headers: authHeaders() });
          rows = Array.isArray(data.data) ? data.data : [];
        } catch { /* \u4f1a\u8bdd/\u7f51\u7edc\u95ee\u9898\uff1a\u4e0b\u4e00\u8f6e\u518d\u8bd5 */ }
        if (rows.length) {
          const used = usedUrls();
          // \u7ec8\u6001\u884c\uff08\u6210\u529f\u5e26\u6587\u4ef6 / \u5931\u8d25\u5e26\u539f\u56e0\uff09\uff0c\u6309\u65f6\u95f4\u5347\u5e8f\uff0c\u65b9\u4fbf\u6309\u53d1\u751f\u987a\u5e8f\u56de\u586b
          const terminal = rows.map((r) => ({
            ts: Number(r.ts || 0) * 1000,
            status: r.status,
            prompt: r.prompt,
            error: r.error,
            file: r.file ? String(r.file).replace(/\\/g, "/") : "",
          })).filter((r) => (r.status === "success" && r.file) || r.status === "failed")
            .sort((a, b) => a.ts - b.ts);
          let changed = false;
          // \u5148\u56de\u586b\u6210\u529f\uff0c\u518d\u5904\u7406\u5931\u8d25\u2014\u2014\u907f\u514d\u660e\u660e\u6709\u6210\u54c1\u5374\u5148\u88ab\u540c prompt \u7684\u5931\u8d25\u884c\u5360\u7528
          for (const phase of ["success", "failed"]) {
            for (const { task, img } of pending()) {
              const lower = task.createdAt - 120000;   // \u5141\u8bb8 2 \u5206\u949f\u65f6\u949f/\u6392\u961f\u504f\u5dee
              const cand = terminal.find((r) => r.status === phase && r.ts >= lower
                && promptHit(r.prompt, task.prompt)
                && (phase !== "success" || (r.file && !used.has(`/images/${r.file}`))));
              if (!cand) continue;
              if (phase === "success") {
                const url = `/images/${cand.file}`;
                used.add(url);
                Object.assign(img, { status: "success", url, message: "", recover: false, error: "" });
              } else {
                Object.assign(img, { status: "error", error: cand.error || "\u751f\u6210\u5931\u8d25", message: "", recover: false });
              }
              const ix = terminal.indexOf(cand);
              if (ix >= 0) terminal.splice(ix, 1);       // \u4e00\u6761\u65e5\u5fd7\u53ea\u56de\u586b\u4e00\u6b21
              changed = true;
            }
          }
          if (changed) { saveTasks(); render(); void refreshMe(); void loadCreditHistory(); }
        }
        if (!pending().length) break;
        round++;
        await sleep(round < 3 ? 3000 : 5000);
      }
    } finally {
      state.reconciling = false;
      // \u5230\u70b9\u4ecd\u6ca1\u627e\u56de\u7684\uff1a\u7ed9\u6e29\u548c\u63d0\u793a\uff08\u4fdd\u6301 loading \u8f6c\u5708\uff0c\u7edd\u4e0d\u8bef\u62a5\u300c\u751f\u6210\u5931\u8d25\u300d\uff09\uff0c
      // \u4e0b\u6b21\u8fdb\u5165\u9875\u9762\u8fd8\u4f1a\u518d\u81ea\u52a8\u5c1d\u8bd5\u6062\u590d\u3002
      let __changed = false;
      for (const { img } of pending()) {
        const tip = "\u751f\u6210\u53ef\u80fd\u5df2\u5b8c\u6210\uff0c\u8bf7\u5230\u300c\u6211\u7684\u56fe\u7247\u300d\u67e5\u770b\uff1b\u5982\u672a\u51fa\u73b0\u53ef\u7a0d\u540e\u91cd\u8bd5\u3002";
        if (img.message !== tip) { img.message = tip; img.recover = true; __changed = true; }
      }
      if (__changed) { saveTasks(); render(); }
    }
  }

  async function syncRecentBackendTasks() {
    // \u540c\u6b65\u65b9\u6848\u65e0\u670d\u52a1\u5668\u5f85\u540c\u6b65\u4efb\u52a1\uff1b\u4fdd\u7559\u7a7a\u5b9e\u73b0\u4ee5\u517c\u5bb9\u521d\u59cb\u5316\u8c03\u7528\u3002
    return;
    /* eslint-disable no-unreachable */
    if (!state.key) return;
    try {
      const data = await api("/api/image-tasks", { headers: { Authorization: `Bearer ${state.key}` } });
      const byId = new Map((data.items || []).map(item => [item.id, item]));
      let changed = false;
      for (const task of state.tasks) {
        const seenTaskIds = new Set();
        for (const img of [...(task.images || [])]) {
          if (!img.taskId || seenTaskIds.has(img.taskId)) continue;
          seenTaskIds.add(img.taskId);
          const remote = byId.get(img.taskId);
          if (!remote) continue;
          if (remote.status === "success") {
            applyTaskSuccessImages(task, img, remote, img.taskId);
            changed = true;
          } else if (img.status === "loading" && (remote.status === "error" || remote.status === "canceled")) {
            Object.assign(img, { status: "error", error: remote.error || "\u751f\u6210\u5931\u8d25", message: "" });
            changed = true;
          }
        }
      }
      if (changed) { saveTasks(); render(); }
    } catch {}
  }

  els.textModeBtn.onclick = () => setMode("text");
  els.imageModeBtn.onclick = () => setMode("image");
  if (els.videoModeBtn) els.videoModeBtn.onclick = () => setMode("video");
  if (els.videoModel) els.videoModel.onchange = applyVideoModelUi;
  for (const el of [els.vidResolution, els.vidOrient]) { if (el) el.onchange = updateCostHint; }
  if (els.vidSeconds) els.vidSeconds.onchange = updateCostHint;
  els.pickImageBtn.onclick = () => els.imageInput.click();
  // 追加参考图的公共逻辑（文件选择 / 剪贴板粘贴共用）：去重、限 MAX_REF、渲染，返回新增张数
  // 上传前把大图用 canvas 压到最长边 maxDim(默认2048),避免高分辨率图解码成巨大位图把后端内存吃爆。
  // 小图/失败原样返回。返回 Promise<File>。
  function downscaleImageFile(file, maxDim = 1024) {
    return new Promise((resolve) => {
      try {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          const w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h || Math.max(w, h) <= maxDim) { URL.revokeObjectURL(url); resolve(file); return; }
          try {
            const scale = maxDim / Math.max(w, h);
            const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
            const canvas = document.createElement("canvas");
            canvas.width = nw; canvas.height = nh;
            canvas.getContext("2d").drawImage(img, 0, 0, nw, nh);
            URL.revokeObjectURL(url);
            const isPng = (file.type === "image/png");
            canvas.toBlob((blob) => {
              if (!blob) { resolve(file); return; }
              const base = (file.name || "image").replace(/\.[^.]+$/, "");
              resolve(new File([blob], base + (isPng ? "_r.png" : "_r.jpg"), { type: blob.type }));
            }, isPng ? "image/png" : "image/jpeg", 0.9);
          } catch { URL.revokeObjectURL(url); resolve(file); }
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
        img.src = url;
      } catch { resolve(file); }
    });
  }

  async function addReferenceFiles(files) {
    const picked = Array.from(files || []).filter(file => file && file.type && file.type.startsWith("image/"));
    const maxRefs = maxReferenceFiles();
    let skipped = false, added = 0;
    for (const raw of picked) {
      if (state.referenceFiles.length >= maxRefs) { skipped = true; break; }
      const file = await downscaleImageFile(raw, 1024);
      // 同名同大小才视为重复（压缩确定性→同图重复添加仍能去重）
      const dup = state.referenceFiles.some(f => f.name === file.name && f.size === file.size);
      if (dup) continue;
      state.referenceFiles.push(file);
      added++;
      renderReferences();
    }
    if (skipped) setMessage(`参考图最多 ${maxRefs} 张，多余的未添加`, "error");
    renderReferences();
    return added;
  }
  els.imageInput.onchange = () => {
    addReferenceFiles(els.imageInput.files);
    // 清空 input，使下次还能选（含同一文件/换目录），且不会用新选择覆盖已添加的
    els.imageInput.value = "";
  };
  // 是否可添加参考图：图生图，或当前视频模型允许参考帧。
  function refInputAllowed() {
    if (state.mode === "image") return true;
    return state.mode === "video" && Number(currentVideoModel()?.max_reference_images || 0) > 0;
  }
  // 剪贴板图片常叫 image.png，重命名（带时间戳）避免被同名去重误判
  function _clipboardImageFiles(blobs) {
    const out = [];
    for (const b of blobs) {
      if (!b || !b.type || !b.type.startsWith("image/")) continue;
      const ext = ((b.type.split("/")[1] || "png").split("+")[0]) || "png";
      out.push(new File([b], `clipboard-${Date.now()}-${out.length}.${ext}`, { type: b.type }));
    }
    return out;
  }
  // Ctrl+V 粘贴：图生图/可传参考图模式下，把剪贴板里的图片直接加为参考图
  document.addEventListener("paste", (ev) => {
    if (!refInputAllowed()) return;
    const items = (ev.clipboardData && ev.clipboardData.items) || [];
    const blobs = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) blobs.push(f);
      }
    }
    const imgs = _clipboardImageFiles(blobs);
    if (!imgs.length) return;
    ev.preventDefault();
    addReferenceFiles(imgs).then(n => { if (n > 0) setMessage(`已从剪贴板粘贴 ${n} 张参考图`, "success"); });
  });
  // 「从剪贴板粘贴」按钮：主动读剪贴板（需用户手势/授权）
  async function pasteFromClipboard() {
    if (!refInputAllowed()) { setMessage("请先切到图生图模式再粘贴", "error"); return; }
    if (!(navigator.clipboard && navigator.clipboard.read)) {
      setMessage("当前浏览器不支持读取剪贴板，请直接按 Ctrl+V 粘贴", "error");
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      const blobs = [];
      for (const it of items) {
        const type = (it.types || []).find(t => t.startsWith("image/"));
        if (type) blobs.push(await it.getType(type));
      }
      const imgs = _clipboardImageFiles(blobs);
      if (!imgs.length) { setMessage("剪贴板里没有图片", "error"); return; }
      const n = await addReferenceFiles(imgs);
      if (n > 0) setMessage(`已从剪贴板导入 ${n} 张参考图`, "success");
    } catch (e) {
      setMessage("读取剪贴板失败（可能未授权），可直接按 Ctrl+V 粘贴", "error");
    }
  }
  const _pasteImageBtn = document.getElementById("pasteImageBtn");
  if (_pasteImageBtn) _pasteImageBtn.onclick = pasteFromClipboard;
  els.referenceList.onclick = (ev) => {
    const btn = ev.target.closest("button[data-remove-ref]");
    if (!btn) return;
    state.referenceFiles.splice(Number(btn.dataset.removeRef), 1);
    els.imageInput.value = "";
    renderReferences();
  };
  els.presetList.onclick = (ev) => {
    ev.stopPropagation();
    const tab = ev.target.closest(".case-tab");
    if (tab) {
      state.presetTab = tab.dataset.presetTab || "text";
      renderPresets();
      return;
    }
    const item = ev.target.closest(".case-item");
    if (!item) return;
    const text = item.dataset.prompt || "";
    els.prompt.value = els.prompt.value.trim() ? `${els.prompt.value.trim()}\uff0c${text}` : text;
    savePromptDraft();
    if (state.presetTab === "image") setMode("image");
    els.prompt.focus();
    els.presetPopover.classList.add("hidden");
  };

  els.presetToggleBtn.onclick = (ev) => { ev.stopPropagation(); els.presetPopover.classList.toggle("hidden"); };
  els.presetPopover.onclick = (ev) => ev.stopPropagation();
  document.addEventListener("click", (ev) => {
    if (!els.presetPopover.contains(ev.target) && ev.target !== els.presetToggleBtn) {
      els.presetPopover.classList.add("hidden");
    }
  });

  els.loginBtn.onclick = () => { setAuthTab("login"); els.loginDialog.showModal(); };
  if (els.registerBtn) els.registerBtn.onclick = () => { setAuthTab("register"); els.loginDialog.showModal(); };
  els.logoutBtn.onclick = () => {
    // 尽力通知后端登出（吊销会话），随后清本地状态。
    api("/admin/api/auth/logout", { method: "POST", headers: authHeaders() }).catch(() => {});
    setSessionToken("");
    state.identity = null; state.apiKeyPlain = ""; state.apiKeyInfo = null;
    updateAuthUI();
  };
  if (els.loginTabBtn) els.loginTabBtn.onclick = () => setAuthTab("login");
  if (els.registerTabBtn) els.registerTabBtn.onclick = () => setAuthTab("register");
  if (els.refreshCaptchaBtn) els.refreshCaptchaBtn.onclick = () => loadCaptcha();
  if (els.registerSubmitBtn) els.registerSubmitBtn.onclick = submitRegister;
  [els.loginUsernameInput, els.loginPasswordInput].forEach(input => input && input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); loginWithPassword().catch(e => { const m=e.message||"登录失败"; setAuthInlineMsg(m,"error"); }); } }));
  [els.registerUsernameInput, els.registerPasswordInput, els.registerPasswordConfirmInput, els.captchaAnswerInput].forEach(input => input && input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); submitRegister(); } }));
  els.saveKeyBtn.onclick = async (ev) => {
    ev.preventDefault();
    try { await loginWithPassword(); }
    catch(e) { const m = e.message || "登录失败"; setAuthInlineMsg(m, "error"); }
  };
  if (els.refreshHistoryBtn) els.refreshHistoryBtn.onclick = loadCreditHistory;
  if (els.refreshRechargeHistoryBtn) els.refreshRechargeHistoryBtn.onclick = loadRechargeHistory;
  if (els.redeemBtn) els.redeemBtn.onclick = redeemCode;
  if (els.redeemCodeInput) els.redeemCodeInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") redeemCode(); });
  els.generate.onclick = generate;
  // 失败自动重试：记住勾选/次数，不勾时把次数框灰掉
  (function initAutoRetry(){
    try {
      const on = localStorage.getItem("autoRetryOn"), n = localStorage.getItem("autoRetryN");
      if (els.autoRetryToggle && on != null) els.autoRetryToggle.checked = on === "1";
      if (els.autoRetryCount && n) els.autoRetryCount.value = n;
    } catch {}
    const sync = () => { if (els.autoRetryCount) els.autoRetryCount.disabled = !(els.autoRetryToggle && els.autoRetryToggle.checked); };
    if (els.autoRetryToggle) els.autoRetryToggle.addEventListener("change", () => { try { localStorage.setItem("autoRetryOn", els.autoRetryToggle.checked ? "1" : "0"); } catch {} sync(); });
    if (els.autoRetryCount) els.autoRetryCount.addEventListener("change", () => { try { localStorage.setItem("autoRetryN", String(els.autoRetryCount.value || 3)); } catch {} });
    sync();
  })();
  els.quality.onchange = updateCostHint;
  els.count.onchange = updateCostHint;
  if (els.model) els.model.onchange = applyModelUi;
  els.clear.onclick = () => { state.tasks = []; state.selected.clear(); saveTasks(); if (state.selectMode) setSelectMode(false); else render(); };

  // ================= 生成结果：选择 / 批量下载 =================
  function collectSelectableSrcs() {
    // 当前所有「可下载」的成功图 src（按渲染顺序），供全选/统计用
    return Array.from(els.output.querySelectorAll(".image-card[data-src]"))
      .map((el) => el.getAttribute("data-src"))
      .filter(Boolean);
  }
  function updateSelectUI() {
    const n = state.selected.size;
    if (els.downloadSelectedBtn) {
      els.downloadSelectedBtn.textContent = n ? `下载选中(${n})` : "下载选中";
      els.downloadSelectedBtn.disabled = n === 0;
    }
    if (els.selectAllBtn) {
      const total = collectSelectableSrcs().length;
      els.selectAllBtn.textContent = total > 0 && n >= total ? "取消全选" : "全选";
    }
  }
  function setSelectMode(on) {
    state.selectMode = !!on;
    if (!on) state.selected.clear();
    for (const btn of [els.selectAllBtn, els.downloadSelectedBtn, els.exitSelectBtn]) {
      if (btn) btn.hidden = !on;
    }
    if (els.selectModeBtn) els.selectModeBtn.hidden = on;
    render();
    updateSelectUI();
  }
  function enterSelectMode() {
    if (!state.tasks.length) { showToast("还没有可选择的图片", "error"); return; }
    setSelectMode(true);
  }
  function toggleSelectSrc(src) {
    if (!src) return;
    const has = state.selected.has(src);
    if (has) state.selected.delete(src); else state.selected.add(src);
    // 局部更新该卡片，避免整列重渲染让图片闪一下
    let card = null;
    try { card = els.output.querySelector(`.image-card[data-src="${CSS.escape(src)}"]`); } catch { card = null; }
    if (card) {
      card.classList.toggle("selected", !has);
      const chk = card.querySelector(".select-check");
      if (chk) { chk.classList.toggle("on", !has); chk.textContent = !has ? "✓" : ""; }
    }
    updateSelectUI();
  }
  function toggleSelectAll() {
    const srcs = collectSelectableSrcs();
    if (srcs.length && state.selected.size >= srcs.length) state.selected.clear();
    else state.selected = new Set(srcs);
    render();
    updateSelectUI();
  }
  async function srcToBytes(src) {
    if (src.startsWith("data:")) {
      const comma = src.indexOf(","); const b64 = src.slice(comma + 1);
      const bin = atob(b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const m = src.match(/^data:image\/([a-z0-9]+)/i);
      return { bytes, ext: m ? m[1] : "png" };
    }
    // https 页面上 fetch http 图会被「混合内容」拦(报 Failed to fetch);服务端同域支持 https,直接升级
    if (src.startsWith("http://") && location.protocol === "https:") src = src.replace(/^http:\/\//, "https://");
    const resp = await fetch(src, { credentials: "same-origin" });
    if (!resp.ok) throw new Error("fetch " + resp.status);
    const buf = await resp.arrayBuffer();
    const m = src.split("?")[0].match(/\.([a-z0-9]+)$/i);
    return { bytes: new Uint8Array(buf), ext: m ? m[1] : "png" };
  }
  async function downloadSelected() {
    const srcs = [...state.selected];
    if (!srcs.length) { showToast("请先勾选要下载的图片", "error"); return; }
    const btn = els.downloadSelectedBtn;
    const oldText = btn ? btn.textContent : "";
    const setBtn = (t, dis) => { if (btn) { btn.textContent = t; btn.disabled = !!dis; } };
    const errStr = (e) => (e && (e.name + ": " + (e.message || ""))) || String(e || "未知错误");
    const srcHint = (u) => { try { const x = new URL(u, location.origin); return x.host + "…" + x.pathname.slice(-28); } catch { return String(u || "").slice(0, 60); } };
    // 优先：选一个文件夹，把原图逐张写进去（不压缩）。Chrome/Edge 等支持 File System Access
    let dir = null;
    if (typeof window.showDirectoryPicker === "function") {
      try {
        dir = await window.showDirectoryPicker({ mode: "readwrite" });
      } catch (e) {
        if (e && e.name === "AbortError") return;  // 用户主动取消选文件夹
        dir = null;  // 其他异常（不支持/被策略禁用）→ 回退逐张下载
      }
    }
    if (dir) {
      // 确保写入权限（旧版 Chrome 选完可能仍是只读；没权限就换个文件夹或授权「编辑文件」）
      try {
        if (dir.queryPermission && (await dir.queryPermission({ mode: "readwrite" })) !== "granted"
            && dir.requestPermission && (await dir.requestPermission({ mode: "readwrite" })) !== "granted") {
          showToast("没有该文件夹的写入权限，换个普通文件夹（别选系统盘根目录/桌面/下载）再试", "error");
          return;
        }
      } catch (_) { /* 无 query/requestPermission 的实现，忽略，靠下面写入报错兜底 */ }
      setBtn("保存中…", true);
      let ok = 0, failed = 0, idx = 0, firstErr = "", firstErrSrc = "";
      for (const src of srcs) {
        idx++;
        try {
          const { bytes, ext } = await srcToBytes(src);
          const fh = await dir.getFileHandle(`image-${String(idx).padStart(2, "0")}.${ext}`, { create: true });
          const w = await fh.createWritable();
          await w.write(bytes); await w.close();
          ok++;
        } catch (e) { failed++; if (!firstErr) { firstErr = errStr(e); firstErrSrc = src; } }
      }
      setBtn(oldText, false);
      if (ok) showToast(failed ? `已保存 ${ok} 张（${failed} 张失败：${firstErr}｜图源 ${srcHint(firstErrSrc)}）` : `已保存 ${ok} 张到所选文件夹`, failed ? "error" : "ok");
      else showToast(`保存失败：${firstErr}｜图源 ${srcHint(firstErrSrc)}`, "error");
      updateSelectUI();
      return;
    }
    // 回退（浏览器不支持选文件夹，如 Safari/部分手机浏览器）：逐张下载，不压缩
    setBtn("下载中…", true);
    let idx = 0, failed = 0, firstErr = "";
    for (const src of srcs) {
      idx++;
      try {
        const { bytes, ext } = await srcToBytes(src);
        const url = URL.createObjectURL(new Blob([bytes]));
        const a = document.createElement("a"); a.href = url; a.download = `image-${String(idx).padStart(2, "0")}.${ext}`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        await new Promise((r) => setTimeout(r, 250));
      } catch (e) { failed++; if (!firstErr) firstErr = errStr(e); }
    }
    setBtn(oldText, false);
    if (idx - failed > 0) showToast(failed ? `已下载 ${idx - failed} 张（${failed} 张失败：${firstErr}）` : `已逐张下载 ${idx} 张`, failed ? "error" : "ok");
    else showToast("下载失败：" + firstErr, "error");
    updateSelectUI();
  }
  if (els.selectModeBtn) els.selectModeBtn.onclick = enterSelectMode;
  if (els.exitSelectBtn) els.exitSelectBtn.onclick = () => setSelectMode(false);
  if (els.selectAllBtn) els.selectAllBtn.onclick = toggleSelectAll;
  if (els.downloadSelectedBtn) els.downloadSelectedBtn.onclick = downloadSelected;

  els.output.onclick = (ev) => {
    // 选择模式：点卡片=勾选/取消（拦截 lightbox 与下载链接跳转）
    if (state.selectMode) {
      const card = ev.target.closest(".image-card[data-src]");
      if (card) { ev.preventDefault(); toggleSelectSrc(card.getAttribute("data-src")); }
      return;
    }
    const action = ev.target.closest("[data-image-action]");
    if (action) {
      ev.stopPropagation();
      if (action.dataset.imageAction === "download") return;
      ev.preventDefault();
      const card = action.closest(".image-card[data-src]");
      const src = card?.getAttribute("data-src") || "";
      if (action.dataset.imageAction === "copy") void copyGeneratedImage(src);
      else if (action.dataset.imageAction === "reference") void useGeneratedImageAsReference(src);
      else if (action.dataset.imageAction === "delete") void deleteGeneratedImage(src);
      return;
    }
    const img = ev.target.closest("img[data-preview]"); if (img) openLightbox(img.dataset.preview);
  };
  els.closeLightbox.onclick = closeLightbox;
  els.lightbox.onclick = (ev) => { if (ev.target === els.lightbox) closeLightbox(); };
  els.prevImageBtn.onclick = (ev) => { ev.stopPropagation(); switchLightbox(-1); };
  els.nextImageBtn.onclick = (ev) => { ev.stopPropagation(); switchLightbox(1); };
  els.zoomOutBtn.onclick = () => zoomImage(-0.2);
  els.zoomInBtn.onclick = () => zoomImage(0.2);
  els.rotateLeftBtn.onclick = () => { view.rotate -= 90; applyImageView(); };
  els.rotateRightBtn.onclick = () => { view.rotate += 90; applyImageView(); };
  els.resetViewBtn.onclick = resetImageView;
  els.lightbox.addEventListener("wheel", (ev) => {
    if (els.lightbox.classList.contains("hidden")) return;
    ev.preventDefault();
    zoomImage(ev.deltaY < 0 ? 0.15 : -0.15, ev);
  }, { passive: false });
  els.lightboxImg.addEventListener("pointerdown", (ev) => {
    if (view.scale <= 1) return;
    view.dragging = true;
    view.startX = ev.clientX; view.startY = ev.clientY; view.baseX = view.x; view.baseY = view.y;
    els.lightboxImg.setPointerCapture?.(ev.pointerId);
  });
  window.addEventListener("pointermove", (ev) => {
    if (!view.dragging) return;
    view.x = view.baseX + ev.clientX - view.startX;
    view.y = view.baseY + ev.clientY - view.startY;
    applyImageView();
  });
  window.addEventListener("pointerup", () => { view.dragging = false; });
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeLightbox();
    if (ev.key === "ArrowLeft") switchLightbox(-1);
    if (ev.key === "ArrowRight") switchLightbox(1);
  });
  // 标记页面正在卸载（刷新/关闭/跳转）。用它区分「用户刷新打断的在途请求」与真正的生成失败：
  // 卸载期间被打断的 fetch（Failed to fetch）不当失败落盘，改留成可恢复占位，进入页面自动找回结果。
  window.addEventListener("beforeunload", () => { state.unloading = true; });
  window.addEventListener("pagehide", () => { state.unloading = true; });



  // ================= 我的图片：分页 / 缩略图 / 全选本页·全部选中 / 打包zip下载 =================
  const myImg = { items: [], page: 1, pageSize: 20, selected: new Set(), loaded: false };
  async function loadMyImages(force) {
    const summary = document.getElementById("myImgSummary");
    if (!state.key) { renderMyImages(); return; }
    if (myImg.loaded && !force) { renderMyImages(); return; }
    if (summary) summary.textContent = "加载中…";
    try {
      // 网关：GET /admin/api/my-images → { data:[{ name(存储键 owner/xxx.png), size, mtime, kind }] }
      // 无 url/缩略图/prompt 字段：原图 = /images/<name>，缩略图 = /images/<name>.thumb.jpg（失败回退原图）。
      const data = await api("/admin/api/my-images", { headers: authHeaders() });
      const raw = Array.isArray(data.data) ? data.data : [];
      const items = raw.map(x => ({
        path: x.name || "",
        url: x.name ? `/images/${x.name}` : "",
        thumbnail_url: x.name ? `/images/${x.name}.thumb.jpg` : "",
        prompt: "",
        kind: x.kind || "image",
        mtime: Number(x.mtime || 0),
      })).filter(x => x.path);
      // mtime 倒序 = 新图在前
      items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      myImg.items = items; myImg.loaded = true; myImg.page = 1;
      const valid = new Set(items.map(x => x.path));
      for (const p of [...myImg.selected]) if (!valid.has(p)) myImg.selected.delete(p);
      renderMyImages();
    } catch (e) { if (summary) summary.textContent = "加载失败：" + (e.message || e); }
  }
  function myImgPageItems() {
    const start = (myImg.page - 1) * myImg.pageSize;
    return myImg.items.slice(start, start + myImg.pageSize);
  }
  function renderMyImages() {
    const grid = document.getElementById("myImgGrid");
    const pager = document.getElementById("myImgPager");
    const summary = document.getElementById("myImgSummary");
    const dlBtn = document.getElementById("myImgDownloadBtn");
    const clearBtn = document.getElementById("myImgClearBtn");
    if (!grid) return;
    if (!state.key) { grid.innerHTML = ""; if (pager) pager.innerHTML = ""; if (summary) summary.textContent = "登录后查看我的图片。"; return; }
    const total = myImg.items.length;
    const totalPages = Math.max(1, Math.ceil(total / myImg.pageSize));
    if (myImg.page > totalPages) myImg.page = totalPages;
    grid.innerHTML = myImgPageItems().map(it => {
      const path = escapeHtml(it.path || "");
      const thumb = escapeHtml(it.thumbnail_url || it.url || "");
      const full = escapeHtml(it.url || "");
      const sel = myImg.selected.has(it.path);
      // 点图片=放大看细节;点右上角圆圈=勾选。两个动作分开(见 initMyImages 的点击分流)。
      // 缩略图 .thumb.jpg 可能不存在（如视频/未生成缩略图）→ onerror 回退原图。
      return `<div class="myimg-card" data-path="${path}" title="${escapeHtml((it.prompt || "").slice(0, 80))}" style="position:relative;border:2px solid ${sel ? "#4a90e2" : "transparent"};border-radius:8px;overflow:hidden;aspect-ratio:1/1;background:#8882"><img src="${thumb}" loading="lazy" alt="" onerror="this.onerror=null;this.src='${full}'" style="width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in"/><span data-mi-toggle="1" title="选择这张" style="position:absolute;top:5px;right:5px;width:26px;height:26px;border-radius:50%;background:${sel ? "#4a90e2" : "rgba(0,0,0,.45)"};color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;border:2px solid rgba(255,255,255,.75)">${sel ? "✓" : ""}</span></div>`;
    }).join("");
    if (summary) summary.textContent = total ? `共 ${total} 张，已选 ${myImg.selected.size} 张` : "还没有图片。";
    if (dlBtn) { dlBtn.disabled = myImg.selected.size === 0; dlBtn.textContent = myImg.selected.size ? `打包下载(${myImg.selected.size})` : "打包下载"; }
    if (clearBtn) clearBtn.hidden = myImg.selected.size === 0;
    if (pager) {
      if (totalPages <= 1) pager.innerHTML = "";
      else {
        const b = (label, pg, dis) => `<button class="link-btn" type="button" data-mipage="${pg}" ${dis ? "disabled" : ""}>${label}</button>`;
        pager.innerHTML = b("上一页", myImg.page - 1, myImg.page <= 1) + `<span class="muted-text">${myImg.page} / ${totalPages}</span>` + b("下一页", myImg.page + 1, myImg.page >= totalPages);
      }
    }
  }
  function openMyImgLightbox(path) {
    const it = myImg.items.find(x => x.path === path);
    if (!it) return;
    const full = it.url || it.thumbnail_url || "";
    let ov = document.getElementById("myImgLightbox");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "myImgLightbox";
      ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.88);display:none;align-items:center;justify-content:center;flex-direction:column;padding:24px;cursor:zoom-out";
      ov.addEventListener("click", () => { ov.style.display = "none"; });
      document.body.appendChild(ov);
    }
    const cap = it.prompt ? `<div style="color:#eee;margin-top:14px;max-width:82vw;text-align:center;font-size:13px;line-height:1.55;max-height:18vh;overflow:auto">${escapeHtml(it.prompt)}</div>` : "";
    ov.innerHTML = `<img src="${escapeHtml(full)}" alt="" style="max-width:94vw;max-height:80vh;object-fit:contain;border-radius:8px;box-shadow:0 10px 44px rgba(0,0,0,.55)"/>${cap}<div style="color:#aaa;margin-top:10px;font-size:12px">点击任意处关闭 · <a href="${escapeHtml(full)}" target="_blank" rel="noopener" style="color:#7ab8ff">查看/下载原图</a></div>`;
    ov.style.display = "flex";
  }
  function myImgSaveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    showToast("已开始下载（浏览器默认下载目录）", "ok");
  }
  // ---- 客户端打包 ZIP（无第三方库，store 存储不压缩；图片本就压缩过，无损直存）----
  // 网关 后端没有服务器端打包下载接口，参考其自带前端（用 fflate 客户端 zip）的做法，
  // 这里内置一个极简 ZIP writer（本地头 + 中央目录 + EOCD + CRC32），零依赖、可离线。
  const _crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function _u8FromName(name) { return new TextEncoder().encode(name); }
  // entries: [{ name:string, bytes:Uint8Array }] → Uint8Array(ZIP)
  function buildStoreZip(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const w16 = (v) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);
    const w32 = (v) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
    for (const e of entries) {
      const nameBytes = _u8FromName(e.name);
      const data = e.bytes;
      const crc = crc32(data);
      const local = [];
      local.push(w32(0x04034b50)); // local file header sig
      local.push(w16(20));         // version needed
      local.push(w16(0));          // flags
      local.push(w16(0));          // method 0 = store
      local.push(w16(0)); local.push(w16(0)); // mod time/date
      local.push(w32(crc));
      local.push(w32(data.length)); // compressed size
      local.push(w32(data.length)); // uncompressed size
      local.push(w16(nameBytes.length));
      local.push(w16(0));           // extra len
      local.push(nameBytes);
      local.push(data);
      const localBytes = concatU8(local);
      chunks.push(localBytes);
      const cen = [];
      cen.push(w32(0x02014b50)); // central dir sig
      cen.push(w16(20)); cen.push(w16(20)); // version made by / needed
      cen.push(w16(0)); cen.push(w16(0));   // flags / method
      cen.push(w16(0)); cen.push(w16(0));   // time / date
      cen.push(w32(crc));
      cen.push(w32(data.length)); cen.push(w32(data.length));
      cen.push(w16(nameBytes.length));
      cen.push(w16(0)); cen.push(w16(0));   // extra / comment len
      cen.push(w16(0)); cen.push(w16(0));   // disk / internal attrs
      cen.push(w32(0));                     // external attrs
      cen.push(w32(offset));                // local header offset
      cen.push(nameBytes);
      central.push(concatU8(cen));
      offset += localBytes.length;
    }
    const centralBytes = concatU8(central);
    const eocd = [];
    eocd.push(new Uint8Array([0x50, 0x4b, 0x05, 0x06]));
    eocd.push(w16(0)); eocd.push(w16(0));
    eocd.push(w16(entries.length)); eocd.push(w16(entries.length));
    eocd.push(w32(centralBytes.length));
    eocd.push(w32(offset));
    eocd.push(w16(0));
    return concatU8([...chunks, centralBytes, concatU8(eocd)]);
  }
  function concatU8(arrs) {
    let total = 0;
    for (const a of arrs) total += a.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of arrs) { out.set(a, p); p += a.length; }
    return out;
  }
  async function downloadMyImages() {
    const paths = [...myImg.selected];
    if (!paths.length) { showToast("请先勾选要下载的图片", "error"); return; }
    const btn = document.getElementById("myImgDownloadBtn");
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "打包中…"; }
    const toUrl = (p) => {
      let u = p.startsWith("http") || p.startsWith("/") ? p : `/images/${p}`;
      if (u.startsWith("http://") && location.protocol === "https:") u = u.replace(/^http:\/\//, "https://");
      return u;
    };
    try {
      // 单张：直接下载原图，不打包。
      if (paths.length === 1) {
        const only = paths[0];
        const resp = await fetch(toUrl(only), { credentials: "same-origin" });
        if (!resp.ok) throw new Error("下载失败 " + resp.status);
        const blob = await resp.blob();
        myImgSaveBlob(blob, only.split("/").pop() || "image.png");
        return;
      }
      // 多张：并发抓取（≤10）→ 内置 store zip → 下载。
      const entries = new Array(paths.length);
      const nameSeen = Object.create(null);
      let next = 0, failed = 0, firstErr = "";
      await Promise.all(Array.from({ length: Math.min(10, paths.length) }, async () => {
        while (next < paths.length) {
          const i = next++;
          const p = paths[i];
          try {
            const resp = await fetch(toUrl(p), { credentials: "same-origin" });
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const buf = new Uint8Array(await resp.arrayBuffer());
            let base = p.split("/").pop() || `image-${i + 1}.png`;
            while (nameSeen[base]) base = "_" + base; // 去重同名
            nameSeen[base] = 1;
            entries[i] = { name: base, bytes: buf };
          } catch (err) { failed++; if (!firstErr) firstErr = err.message || String(err); }
        }
      }));
      const ok = entries.filter(Boolean);
      if (!ok.length) throw new Error("全部下载失败：" + firstErr);
      const zipBytes = buildStoreZip(ok);
      const blob = new Blob([zipBytes], { type: "application/zip" });
      const name = `我的图片_${ok.length}张_${new Date().toISOString().slice(0, 10)}.zip`;
      if (typeof window.showSaveFilePicker === "function") {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "ZIP 压缩包", accept: { "application/zip": [".zip"] } }] });
          const w = await handle.createWritable(); await w.write(blob); await w.close();
          showToast(failed ? `已保存 ${ok.length} 张（${failed} 张失败）到所选位置` : `已保存 ${ok.length} 张到所选位置`, failed ? "error" : "ok");
        } catch (e) { if (e && e.name === "AbortError") return; myImgSaveBlob(blob, name); }
      } else {
        myImgSaveBlob(blob, name);
        if (failed) showToast(`已打包 ${ok.length} 张（${failed} 张失败）`, "error");
      }
    } catch (e) { showToast(e.message || "下载失败", "error"); }
    finally { if (btn) { btn.textContent = old; btn.disabled = myImg.selected.size === 0; } }
  }
  function initMyImages() {
    const grid = document.getElementById("myImgGrid");
    const pager = document.getElementById("myImgPager");
    if (grid) grid.addEventListener("click", (e) => {
      const card = e.target.closest(".myimg-card"); if (!card) return;
      const path = card.getAttribute("data-path"); if (!path) return;
      if (e.target.closest("[data-mi-toggle]")) {
        // 点中右上角圆圈 → 勾选/取消
        if (myImg.selected.has(path)) myImg.selected.delete(path); else myImg.selected.add(path);
        renderMyImages();
      } else {
        // 点图片本身 → 放大看细节
        openMyImgLightbox(path);
      }
    });
    if (pager) pager.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-mipage]"); if (!b) return;
      const pg = Number(b.dataset.mipage); if (pg >= 1) { myImg.page = pg; renderMyImages(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    });
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    on("myImgSelPageBtn", () => { myImgPageItems().forEach(it => myImg.selected.add(it.path)); renderMyImages(); });
    on("myImgSelAllBtn", () => { myImg.items.forEach(it => myImg.selected.add(it.path)); renderMyImages(); });
    on("myImgClearBtn", () => { myImg.selected.clear(); renderMyImages(); });
    on("myImgRefreshBtn", () => loadMyImages(true));
    on("myImgDownloadBtn", downloadMyImages);
    const psSel = document.getElementById("myImgPageSize");
    if (psSel) {
      psSel.value = String(myImg.pageSize);
      psSel.onchange = () => { myImg.pageSize = Number(psSel.value) || 20; myImg.page = 1; renderMyImages(); };
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { const ov = document.getElementById("myImgLightbox"); if (ov && ov.style.display !== "none") ov.style.display = "none"; }
    });
  }

  function setActiveNav(page) {
    document.querySelectorAll(".side-item:not(.disabled)").forEach(item => {
      item.classList.toggle("active", (item.dataset.page || "home") === page);
    });
  }

  function showPage(page = "home") {
    const normalized = ["home", "history", "api", "recharge", "user", "myimages"].includes(page) ? page : "home";
    const createPanel = document.getElementById("createPanel");
    const outputPanel = document.getElementById("outputPanel");
    const historyPanel = document.getElementById("historyPanel");
    const apiPanel = document.getElementById("apiPanel");
    const rechargePanel = document.getElementById("rechargePanel");
    const userPanel = document.getElementById("userPanel");
    const myImagesPanel = document.getElementById("myImagesPanel");
    if (createPanel) createPanel.classList.toggle("page-hidden", normalized !== "home");
    if (outputPanel) outputPanel.classList.toggle("page-hidden", normalized !== "home");
    if (historyPanel) historyPanel.classList.toggle("page-hidden", normalized !== "history");
    if (apiPanel) apiPanel.classList.toggle("page-hidden", normalized !== "api");
    if (rechargePanel) rechargePanel.classList.toggle("page-hidden", normalized !== "recharge");
    if (userPanel) userPanel.classList.toggle("page-hidden", normalized !== "user");
    if (myImagesPanel) myImagesPanel.classList.toggle("page-hidden", normalized !== "myimages");
    const workspace = document.querySelector(".workspace");
    const infoPanels = document.querySelector(".info-panels");
    if (workspace) workspace.classList.toggle("single-panel", normalized !== "home");
    if (infoPanels) infoPanels.classList.toggle("single-panel", normalized === "history" || normalized === "api" || normalized === "recharge" || normalized === "user" || normalized === "myimages");
    setActiveNav(normalized);
    if (normalized === "user" && state.key) void refreshMe();
    if (normalized === "api" && state.key) { void refreshMe(); void loadApiKey(); }
    if (normalized === "history" && state.key) void loadCreditHistory();
    if (normalized === "recharge" && state.key) void loadRechargeHistory();
    if (normalized === "myimages" && state.key) void loadMyImages();
    if ((normalized === "user" || normalized === "api" || normalized === "history" || normalized === "recharge" || normalized === "myimages") && !state.key) els.loginDialog.showModal();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function initSideNav() {
    document.querySelectorAll(".side-item:not(.disabled)").forEach(btn => {
      btn.addEventListener("click", () => showPage(btn.dataset.page || "home"));
    });
    showPage("home");
  }

  installImageCardActionsStyle(); restorePromptDraft(); void restoreReferenceDraft();
  updateAuthUI(); render(); renderPresets(); setMode("text"); refreshQualityOptions(); updateCostHint(); initSideNav(); initMyImages(); void loadPricing(); void loadVideoConfig(); void loadAdminUrl(); void loadImageModels();
  if (state.key) {
    // 已存 token：校验会话（/me），成功后再拉公告与充值信息；失败则提示重新登录。
    void refreshMe().then(() => { void loadAnnouncement(); }).catch(() => setMessage("登录已失效，请重新登录", "error"));
    void loadRechargeHistory();
  }
  resumePendingTasks();
  void syncRecentBackendTasks();
})();

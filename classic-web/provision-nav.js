/* 开通管理 —— 原生融入 网关 后台(不用 iframe;渐进增强,失败绝不影响后台)。
   点侧边栏「开通管理」→ 在内容区用后台同款主题变量渲染原生面板,和其它后台页一致观感。
   API 走 /register/api/*(nginx 注入上游鉴权 + auth_request 校验后台会话 cookie,无需密码)。
   通过 nginx sub_filter 注入到 /new/ 页面。 */
(function () {
  var LINKID = 'prov-nav-link', PANELID = 'prov-panel', STYLEID = 'prov-style';
  var API = '/register/api/register';
  var lastPath = location.pathname;
  var timer = null;

  function onAdmin() { return location.pathname.indexOf('/new/admin') === 0; }
  function mainEl() { return document.querySelector('main'); }
  function dataV(el) {
    var ns = el.getAttributeNames ? el.getAttributeNames() : [];
    for (var i = 0; i < ns.length; i++) if (ns[i].indexOf('data-v-') === 0) return ns[i];
    return null;
  }
  function num(v) { return (v === null || v === undefined || v === '') ? 0 : v; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  function injectStyle() {
    if (document.getElementById(STYLEID)) return;
    var s = document.createElement('style'); s.id = STYLEID;
    s.textContent = [
      '#' + PANELID + '{position:fixed;z-index:20;overflow:auto;background:var(--app-bg,#0f1216);padding:28px 32px;}',
      '.pv-h1{font-size:20px;font-weight:700;color:var(--fg,#e6eaf0);margin:0 0 2px;}',
      '.pv-sub{font-size:13px;color:var(--fg-3,#9aa6b4);margin:0 0 18px;}',
      '.pv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:18px;}',
      '.pv-card{background:var(--surface,#171b22);border:1px solid var(--hairline,#2a323d);border-radius:14px;padding:14px 16px;}',
      '.pv-card .k{font-size:12px;color:var(--fg-3,#9aa6b4);}',
      '.pv-card .v{font-size:22px;font-weight:700;color:var(--fg,#e6eaf0);margin-top:3px;}',
      '.pv-panel{background:var(--surface,#171b22);border:1px solid var(--hairline,#2a323d);border-radius:14px;padding:18px;margin-bottom:18px;}',
      '.pv-panel h2{font-size:15px;font-weight:600;color:var(--fg,#e6eaf0);margin:0 0 14px;display:flex;align-items:center;gap:8px;}',
      '.pv-row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;}',
      '.pv-fld{display:flex;flex-direction:column;gap:5px;}',
      '.pv-fld label{font-size:12px;color:var(--fg-3,#9aa6b4);}',
      '.pv-in{background:var(--app-bg,#0f1216);border:1px solid var(--hairline,#2a323d);color:var(--fg,#e6eaf0);border-radius:9px;padding:8px 10px;font:inherit;outline:none;}',
      '.pv-in:focus{border-color:#a855f7;}',
      'input.pv-in[type=number]{width:120px;}',
      '.pv-ta{width:100%;min-height:92px;resize:vertical;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;}',
      '.pv-btn{border:0;border-radius:9px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer;color:#fff;background:linear-gradient(180deg,#a855f7,#7c3aed);}',
      '.pv-btn:hover{filter:brightness(1.08);}',
      '.pv-btn.ghost{background:var(--hover,#1e242e);border:1px solid var(--hairline,#2a323d);color:var(--fg,#e6eaf0);}',
      '.pv-btn.danger{background:transparent;border:1px solid #7a3b3b;color:#ff8a8a;}',
      '.pv-pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;}',
      '.pv-pill.on{background:rgba(55,201,139,.16);color:#37c98b;}',
      '.pv-pill.off{background:rgba(154,166,180,.16);color:var(--fg-3,#9aa6b4);}',
      '.pv-logs{background:var(--app-bg,#0b0e12);border:1px solid var(--hairline,#2a323d);border-radius:11px;padding:10px 12px;height:300px;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;}',
      '.pv-logs .l{white-space:pre-wrap;word-break:break-all;}',
      '.pv-green{color:#37c98b;}.pv-red{color:#ff5d5d;}.pv-yellow{color:#f0b429;}.pv-info{color:var(--fg-3,#9aa6b4);}',
      '.pv-sp{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.pv-hint{color:var(--fg-3,#9aa6b4);font-size:12px;margin-top:8px;}',
      '.pv-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface,#222b36);border:1px solid var(--hairline,#2a323d);color:var(--fg,#e6eaf0);padding:10px 16px;border-radius:10px;z-index:40;opacity:0;transition:.2s;pointer-events:none;}',
      '.pv-toast.show{opacity:1;}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function panelHTML() {
    return '' +
      '<div class="pv-sp"><div><h1 class="pv-h1">开通管理 · ChatGPT 号池</h1>' +
      '<p class="pv-sub">自动注册 ChatGPT 账号 → 成功后自动导入账号管理(备用上游)</p></div>' +
      '<span id="pvState" class="pv-pill off">已停止</span></div>' +
      '<div class="pv-grid" id="pvCards"></div>' +
      '<div class="pv-panel"><h2>注册控制</h2><div class="pv-row">' +
      '<div class="pv-fld"><label>模式</label><select id="pvMode" class="pv-in">' +
      '<option value="total">按数量(注册 N 个即停)</option><option value="low_watermark">按水位(维持可用数)</option></select></div>' +
      '<div class="pv-fld" id="pvTotalWrap"><label>本次数量</label><input id="pvTotal" class="pv-in" type="number" min="1" value="20"></div>' +
      '<div class="pv-fld" id="pvTargetWrap" style="display:none"><label>目标可用数</label><input id="pvTarget" class="pv-in" type="number" min="1" value="100"></div>' +
      '<div class="pv-fld"><label>并发线程</label><input id="pvThreads" class="pv-in" type="number" min="1" max="10" value="2"></div>' +
      '<div class="pv-fld" style="flex:1;min-width:220px"><label>代理(可选,留空直连)</label><input id="pvProxy" class="pv-in" type="text" placeholder="http://user:pass@host:port" style="width:100%"></div>' +
      '</div><div class="pv-row" style="margin-top:14px">' +
      '<button class="pv-btn" id="pvStart">▶ 启动注册</button>' +
      '<button class="pv-btn ghost" id="pvStop">■ 停止</button>' +
      '<button class="pv-btn danger" id="pvReset">重置统计</button>' +
      '<button class="pv-btn ghost" id="pvSave">保存配置</button></div>' +
      '<div class="pv-hint">启动前自动保存配置。号池可用邮箱不足时注册会失败,请先在下方导入邮箱。</div></div>' +
      '<div class="pv-panel"><h2>邮箱号池 <span id="pvPool" class="pv-pill off">—</span></h2>' +
      '<div class="pv-fld"><label>批量导入(每行一个)</label><textarea id="pvMail" class="pv-in pv-ta" placeholder="邮箱账号,每行一个…"></textarea></div>' +
      '<div class="pv-row" style="margin-top:10px">' +
      '<div class="pv-fld"><label>邮箱类型</label><select id="pvEmailType" class="pv-in"><option value="outlook_oauth">outlook_oauth(Hotmail/Outlook)</option><option value="">自动/其他</option></select></div>' +
      '<div class="pv-fld"><label>生成别名</label><select id="pvGenAlias" class="pv-in"><option value="0">否</option><option value="1">是</option></select></div>' +
      '<div class="pv-fld" id="pvAliasWrap" style="display:none"><label>每个别名数</label><input id="pvAliasCount" class="pv-in" type="number" min="1" value="5"></div>' +
      '<button class="pv-btn" id="pvImport">导入号池</button>' +
      '<button class="pv-btn ghost" id="pvPoolRefresh">刷新统计</button></div></div>' +
      '<div class="pv-panel"><div class="pv-sp"><h2 style="margin:0">实时日志</h2>' +
      '<button class="pv-btn ghost" id="pvClear" style="padding:5px 12px">清屏</button></div>' +
      '<div class="pv-logs" id="pvLogs" style="margin-top:10px"></div></div>';
  }

  function q(id) { return document.getElementById(id); }
  function toast(msg) {
    var t = q('pvToast');
    if (!t) { t = document.createElement('div'); t.id = 'pvToast'; t.className = 'pv-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2200);
  }
  function api(path, opts) {
    return fetch(API + path, Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, opts || {}))
      .then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (d) { throw new Error((d && (d.detail || d.error)) || ('HTTP ' + r.status)); });
        return r.status === 204 ? {} : r.json();
      });
  }
  function toggleMode() {
    var m = q('pvMode').value;
    q('pvTotalWrap').style.display = m === 'total' ? '' : 'none';
    q('pvTargetWrap').style.display = m === 'low_watermark' ? '' : 'none';
  }
  function curCfg() {
    return { mode: q('pvMode').value, total: +q('pvTotal').value, threads: +q('pvThreads').value, target_available: +q('pvTarget').value, proxy: q('pvProxy').value.trim() };
  }
  function renderCards(s) {
    var cards = [['成功', num(s.success), 'pv-green'], ['失败', num(s.fail), 'pv-red'], ['进行中', num(s.running), ''],
      ['号池可用', num(s.current_available), ''], ['成功率', num(s.success_rate) + '%', ''], ['平均耗时', num(s.avg_seconds) + 's', '']];
    q('pvCards').innerHTML = cards.map(function (c) { return '<div class="pv-card"><div class="k">' + c[0] + '</div><div class="v ' + c[2] + '">' + c[1] + '</div></div>'; }).join('');
  }
  function renderLogs(logs) {
    if (!Array.isArray(logs)) return;
    var box = q('pvLogs'); var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = logs.slice(-400).map(function (l) { return '<div class="l pv-' + (l.level || 'info') + '">' + esc(l.text) + '</div>'; }).join('');
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  function applyCfg(c) {
    var ae = document.activeElement;
    if (ae && ['INPUT', 'SELECT', 'TEXTAREA'].indexOf(ae.tagName) >= 0) return;
    q('pvMode').value = c.mode || 'total'; toggleMode();
    q('pvTotal').value = c.total || 20; q('pvThreads').value = c.threads || 2;
    q('pvTarget').value = c.target_available || 100;
    if (c.proxy !== undefined) q('pvProxy').value = c.proxy || '';
  }
  function poll() {
    api('').then(function (res) {
      var c = res.register || {}, s = c.stats || {};
      var running = num(s.running) > 0 || c.enabled;
      var st = q('pvState'); if (st) { st.className = 'pv-pill ' + (running ? 'on' : 'off'); st.textContent = running ? '注册中' : '已停止'; }
      renderCards(s); renderLogs(c.logs); applyCfg(c);
    }).catch(function () {});
  }
  function refreshPool() {
    api('/mail-pool/stats').then(function (p) {
      var e = q('pvPool'); if (e) { e.className = 'pv-pill on'; e.textContent = '可用 ' + p.pool_available + ' / 共 ' + p.pool_total + ' · 已用 ' + p.pool_used; }
    }).catch(function () { var e = q('pvPool'); if (e) e.textContent = '统计失败'; });
  }
  function wire() {
    q('pvMode').onchange = toggleMode;
    q('pvGenAlias').onchange = function () { q('pvAliasWrap').style.display = q('pvGenAlias').value === '1' ? '' : 'none'; };
    q('pvSave').onclick = function () { api('', { method: 'POST', body: JSON.stringify(curCfg()) }).then(function () { toast('配置已保存'); }).catch(function (e) { toast('保存失败: ' + e.message); }); };
    q('pvStart').onclick = function () { api('', { method: 'POST', body: JSON.stringify(curCfg()) }).then(function () { return api('/start', { method: 'POST' }); }).then(function () { toast('已启动注册'); }).catch(function (e) { toast('启动失败: ' + e.message); }); };
    q('pvStop').onclick = function () { api('/stop', { method: 'POST' }).then(function () { toast('已停止'); }).catch(function (e) { toast('停止失败: ' + e.message); }); };
    q('pvReset').onclick = function () { if (!confirm('确定重置统计?')) return; api('/reset', { method: 'POST' }).then(function () { toast('已重置'); }).catch(function (e) { toast('重置失败: ' + e.message); }); };
    q('pvImport').onclick = function () {
      var text = q('pvMail').value.trim(); if (!text) { toast('请粘贴邮箱'); return; }
      api('/mail-pool/import', { method: 'POST', body: JSON.stringify({ text: text, email_type: q('pvEmailType').value, gen_alias: q('pvGenAlias').value === '1', alias_count: +q('pvAliasCount').value }) })
        .then(function (r) { toast('导入完成: 新增 ' + (r.added != null ? r.added : JSON.stringify(r))); q('pvMail').value = ''; refreshPool(); })
        .catch(function (e) { toast('导入失败: ' + e.message); });
    };
    q('pvPoolRefresh').onclick = refreshPool;
    q('pvClear').onclick = function () { q('pvLogs').innerHTML = ''; };
  }

  function positionPanel(p) { var m = mainEl(); if (!m) return; var r = m.getBoundingClientRect(); p.style.top = r.top + 'px'; p.style.left = r.left + 'px'; p.style.width = r.width + 'px'; p.style.height = r.height + 'px'; }
  function setHeader(t) { var h = document.querySelector('header h1'); if (h && t && h.textContent !== t) h.textContent = t; }
  function panelOpen() { var p = q(PANELID); return p && p.style.display !== 'none'; }
  function showPanel() {
    if (!mainEl()) return;   // <main> 还没挂载(刷新初期),下一轮 tick 再试
    injectStyle();
    var p = q(PANELID);
    if (!p) {
      p = document.createElement('div'); p.id = PANELID; p.innerHTML = panelHTML();
      document.body.appendChild(p); wire(); toggleMode();
    }
    positionPanel(p); p.style.display = 'block';
    var l = q(LINKID); if (l) l.classList.add('active');
    setHeader('开通管理');
    poll(); refreshPool();
    if (timer) clearInterval(timer);
    timer = setInterval(function () { if (panelOpen()) { poll(); } }, 1500);
  }
  function hidePanel() { var p = q(PANELID); if (p) p.style.display = 'none'; var l = q(LINKID); if (l) l.classList.remove('active'); if (timer) { clearInterval(timer); timer = null; } }

  function injectLink() {
    if (!onAdmin()) { hidePanel(); var e = q(LINKID); if (e) e.remove(); return; }
    if (q(LINKID)) return;
    var refs = document.querySelectorAll('nav a.admin-link, nav .admin-link');
    if (!refs.length) return;
    var ref = null;
    for (var i = 0; i < refs.length; i++) if (refs[i].tagName === 'A') { ref = refs[i]; break; }
    if (!ref) ref = refs[0];
    var nav = ref.closest ? ref.closest('nav') : ref.parentNode; if (!nav) return;
    var a = document.createElement('a'); a.id = LINKID; a.href = 'javascript:void(0)';
    a.className = (ref.className || 'admin-link group').replace(/router-link-active|router-link-exact-active|\bactive\b/g, '').replace(/\s+/g, ' ').trim();
    var dv = dataV(ref); if (dv) a.setAttribute(dv, '');
    a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 shrink-0 opacity-70"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.5 12.5 21 2"/><path d="M16 7l3 3"/></svg><span class="text-sm">开通管理</span>';
    if (dv) { var ks = a.querySelectorAll('*'); for (var k = 0; k < ks.length; k++) ks[k].setAttribute(dv, ''); }
    a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); showPanel(); });
    nav.appendChild(a);
  }

  // 只用定时器驱动,不用 MutationObserver —— 避免"改DOM→observer→再改"的反馈死循环。
  function tick() {
    try {
      if (lastPath !== location.pathname) { lastPath = location.pathname; hidePanel(); }
      injectLink();
      if (panelOpen()) { positionPanel(q(PANELID)); setHeader('开通管理'); }
    } catch (e) {}
  }
  window.addEventListener('resize', function () { try { if (panelOpen()) positionPanel(q(PANELID)); } catch (e) {} });
  window.addEventListener('popstate', function () { lastPath = location.pathname; setTimeout(tick, 120); });
  setInterval(tick, 600);
  tick();
})();

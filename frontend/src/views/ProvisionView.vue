<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../components/Icon.vue'

// 开通管理:自动注册 ChatGPT 账号 → 成功后自动导入账号管理(备用上游)。
// 注册引擎在独立服务(nginx /register/api/* 代理,鉴权走后台会话 cookie)。
const REG = '/register/api/register'

const cfg = reactive({ mode: 'total', total: 20, threads: 2, target_available: 100, proxy: '', mailUseProxy: false })
const stats = reactive({ success: 0, fail: 0, running: 0, current_available: 0, success_rate: 0, avg_seconds: 0 })
const logs = ref([])
const running = ref(false)
const pool = reactive({ total: 0, available: 0, used: 0, ok: false })

const mail = reactive({ text: '', email_type: 'outlook_oauth', gen_alias: false, alias_count: 5 })

// 邮箱来源(注册用哪个邮箱服务):cloudflare_temp_email / tempmail_lol / outlook_oauth
const PROVIDER_LABEL = { cloudflare_temp_email: 'Cloudflare 临时邮箱', tempmail_lol: 'TempMail.lol', outlook_oauth: 'Outlook/Hotmail 号池' }
const mailRaw = ref(null)                 // 完整 mail 对象(保留所有字段,只改可见项)
const providers = ref([])                 // mail.providers
const activeType = ref('')                // 当前选中/启用的 provider type
const domainText = ref('')                // 域名 textarea 镜像
const activeProv = computed(() => providers.value.find(p => p.type === activeType.value) || {})

const toast = ref('')
let toastTimer = null
function flash(m) { toast.value = m; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toast.value = ''), 2400) }

async function reg(path, opts = {}) {
  const r = await fetch(REG + path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts })
  if (!r.ok) { let d = null; try { d = await r.json() } catch {} throw new Error((d && (d.detail || d.error)) || ('HTTP ' + r.status)) }
  return r.status === 204 ? {} : r.json()
}

const logsBox = ref(null)
async function poll() {
  try {
    const { register: c } = await reg('')
    const s = c.stats || {}
    running.value = Number(s.running || 0) > 0 || !!c.enabled
    Object.assign(stats, {
      success: s.success || 0, fail: s.fail || 0, running: s.running || 0,
      current_available: s.current_available || 0, success_rate: s.success_rate || 0, avg_seconds: s.avg_seconds || 0,
    })
    if (Array.isArray(c.logs)) {
      const atBottom = logsBox.value ? (logsBox.value.scrollHeight - logsBox.value.scrollTop - logsBox.value.clientHeight < 40) : true
      logs.value = c.logs.slice(-400)
      if (atBottom) requestAnimationFrame(() => { if (logsBox.value) logsBox.value.scrollTop = logsBox.value.scrollHeight })
    }
    // 表单未聚焦时同步后端配置
    const ae = document.activeElement
    if (!ae || !['INPUT', 'SELECT', 'TEXTAREA'].includes(ae.tagName)) {
      cfg.mode = c.mode || 'total'; cfg.total = c.total || 20; cfg.threads = c.threads || 2
      cfg.target_available = c.target_available || 100
      if (c.proxy !== undefined) cfg.proxy = c.proxy || ''
      if (c.mail && c.mail.use_proxy !== undefined) cfg.mailUseProxy = !!c.mail.use_proxy
    }
  } catch { /* 静默,下轮再试 */ }
}
async function refreshPool() {
  try { const p = await reg('/mail-pool/stats'); Object.assign(pool, { total: p.pool_total, available: p.pool_available, used: p.pool_used, ok: true }) }
  catch { pool.ok = false }
}

// —— 邮箱来源配置 ——
async function loadMail() {
  try {
    const { register: c } = await reg('')
    const m = c.mail || {}
    mailRaw.value = m
    providers.value = Array.isArray(m.providers) ? m.providers : []
    const act = providers.value.find(p => p.enable) || providers.value[0]
    activeType.value = act ? act.type : ''
    syncDomainText()
  } catch { /* 静默 */ }
}
function syncDomainText() { const p = activeProv.value; domainText.value = (p && Array.isArray(p.domain)) ? p.domain.join('\n') : '' }
function pickProvider(t) { activeType.value = t; syncDomainText() }
async function saveMail() {
  const p = activeProv.value
  if (p && 'domain' in p) p.domain = domainText.value.split('\n').map(s => s.trim()).filter(Boolean)
  providers.value.forEach(x => { x.enable = (x.type === activeType.value) })
  try {
    await reg('', { method: 'POST', body: JSON.stringify({ mail: { ...(mailRaw.value || {}), providers: providers.value } }) })
    flash('邮箱来源已保存'); loadMail()
  } catch (e) { flash('保存失败: ' + e.message) }
}

function payload() { return { mode: cfg.mode, total: Number(cfg.total), threads: Number(cfg.threads), target_available: Number(cfg.target_available), proxy: (cfg.proxy || '').trim(), mail: { use_proxy: !!cfg.mailUseProxy } } }
async function save() { try { await reg('', { method: 'POST', body: JSON.stringify(payload()) }); flash('配置已保存') } catch (e) { flash('保存失败: ' + e.message) } }
async function start() { try { await reg('', { method: 'POST', body: JSON.stringify(payload()) }); await reg('/start', { method: 'POST' }); flash('已启动注册'); poll() } catch (e) { flash('启动失败: ' + e.message) } }
async function stop() { try { await reg('/stop', { method: 'POST' }); flash('已停止'); poll() } catch (e) { flash('停止失败: ' + e.message) } }
async function reset() { if (!confirm('确定重置统计?')) return; try { await reg('/reset', { method: 'POST' }); flash('已重置'); poll() } catch (e) { flash('重置失败: ' + e.message) } }
async function importMail() {
  const text = (mail.text || '').trim(); if (!text) { flash('请粘贴邮箱'); return }
  try {
    const r = await reg('/mail-pool/import', { method: 'POST', body: JSON.stringify({ text, email_type: mail.email_type, gen_alias: mail.gen_alias, alias_count: Number(mail.alias_count) }) })
    flash('导入完成: 新增 ' + (r.added != null ? r.added : JSON.stringify(r))); mail.text = ''; refreshPool()
  } catch (e) { flash('导入失败: ' + e.message) }
}

const logColor = (lv) => ({ green: 'text-emerald-400', red: 'text-rose-400', yellow: 'text-amber-400' }[lv] || 'text-white/50')

let timer = null
onMounted(() => { poll(); refreshPool(); loadMail(); timer = setInterval(() => { poll() }, 1500); poolTimer = setInterval(refreshPool, 15000) })
let poolTimer = null
onBeforeUnmount(() => { clearInterval(timer); clearInterval(poolTimer); clearTimeout(toastTimer) })
</script>

<template>
  <section class="space-y-4">
    <!-- 状态条 -->
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <div class="text-sm text-white/50">自动注册 ChatGPT 账号 → 成功后自动导入账号管理(备用上游)</div>
      </div>
      <span class="pill" :class="running ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30' : 'bg-white/10 text-white/60 ring-1 ring-white/15'">
        {{ running ? '注册中' : '已停止' }}
      </span>
    </div>

    <!-- KPI -->
    <div class="grid grid-cols-2 lg:grid-cols-6 gap-3">
      <div class="card p-4"><div class="text-xs text-white/55">累计成功</div><div class="text-2xl font-semibold tabular-nums mt-1 text-emerald-400">{{ stats.success }}</div><div class="text-[10px] text-white/35 mt-0.5">历史总数,重置清零</div></div>
      <div class="card p-4"><div class="text-xs text-white/55">当前可用</div><div class="text-2xl font-semibold tabular-nums mt-1 text-violet-300">{{ stats.current_available }}</div><div class="text-[10px] text-white/35 mt-0.5">此刻能用的活号</div></div>
      <div class="card p-4"><div class="text-xs text-white/55">失败</div><div class="text-2xl font-semibold tabular-nums mt-1 text-rose-400">{{ stats.fail }}</div></div>
      <div class="card p-4"><div class="text-xs text-white/55">进行中</div><div class="text-2xl font-semibold tabular-nums mt-1">{{ stats.running }}</div></div>
      <div class="card p-4"><div class="text-xs text-white/55">成功率</div><div class="text-2xl font-semibold tabular-nums mt-1">{{ stats.success_rate }}%</div></div>
      <div class="card p-4"><div class="text-xs text-white/55">平均耗时</div><div class="text-2xl font-semibold tabular-nums mt-1">{{ stats.avg_seconds }}s</div></div>
    </div>

    <!-- 控制 -->
    <div class="card p-5">
      <h2 class="text-sm font-semibold mb-4 flex items-center gap-2"><Icon name="spark" class="w-4 h-4" /> 注册控制</h2>
      <div class="flex flex-wrap gap-4 items-end">
        <label class="flex flex-col gap-1.5"><span class="text-xs text-white/55">模式</span>
          <select v-model="cfg.mode" class="field w-56"><option value="total">按数量(注册 N 个即停)</option><option value="low_watermark">按水位(维持可用数)</option></select>
        </label>
        <label v-if="cfg.mode === 'total'" class="flex flex-col gap-1.5"><span class="text-xs text-white/55">本次数量</span><input v-model="cfg.total" type="number" min="1" class="field w-28"></label>
        <label v-else class="flex flex-col gap-1.5"><span class="text-xs text-white/55">目标可用数</span><input v-model="cfg.target_available" type="number" min="1" class="field w-28"></label>
        <label class="flex flex-col gap-1.5"><span class="text-xs text-white/55">并发线程</span><input v-model="cfg.threads" type="number" min="1" max="10" class="field w-28"></label>
        <label class="flex flex-col gap-1.5 flex-1 min-w-[220px]"><span class="text-xs text-white/55">代理(可选,留空直连)</span><input v-model="cfg.proxy" type="text" placeholder="http://user:pass@host:port" class="field w-full"></label>
        <div class="flex flex-col gap-1.5"><span class="text-xs text-white/55">邮箱走代理</span><label class="field flex items-center gap-2 cursor-pointer" style="height:38px;width:auto" title="勾选后，所有配置的邮箱源(临时邮箱/号池等)的接口请求都走上面那个代理"><input v-model="cfg.mailUseProxy" type="checkbox" class="w-4 h-4"><span class="text-xs text-white/70">{{ cfg.mailUseProxy ? '所有邮箱都走上面代理' : '所有邮箱直连' }}</span></label></div>
      </div>
      <div class="flex flex-wrap gap-2.5 mt-4">
        <button @click="start" class="btn-primary">▶ 启动注册</button>
        <button @click="stop" class="btn-ghost">■ 停止</button>
        <button @click="reset" class="btn-ghost text-rose-300">重置统计</button>
        <button @click="save" class="btn-ghost">保存配置</button>
      </div>
      <div class="text-[11px] text-white/40 mt-3">启动前自动保存配置。号池可用邮箱不足时注册会失败,请先在下方导入邮箱。</div>
    </div>

    <!-- 邮箱来源 -->
    <div class="card p-5">
      <h2 class="text-sm font-semibold mb-4 flex items-center gap-2"><Icon name="plug" class="w-4 h-4" /> 邮箱来源(注册用哪个邮箱服务)</h2>
      <div class="flex flex-wrap gap-2 mb-4">
        <button v-for="p in providers" :key="p.type" @click="pickProvider(p.type)" type="button"
          class="btn-soft" :class="activeType === p.type ? 'ring-2 ring-violet-400/70' : ''">
          {{ PROVIDER_LABEL[p.type] || p.type }}
          <span v-if="p.enable" class="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">当前</span>
        </button>
      </div>
      <div v-if="activeType === 'outlook_oauth'" class="text-sm text-white/50">使用下方「邮箱号池」里导入的 Outlook/Hotmail 账号来注册,无需域名配置。</div>
      <template v-else-if="activeType">
        <div class="flex flex-wrap gap-4 items-end">
          <label v-if="'api_base' in activeProv" class="flex flex-col gap-1.5 flex-1 min-w-[240px]"><span class="text-xs text-white/55">API Base</span><input v-model="activeProv.api_base" type="text" class="field w-full" placeholder="https://api.example.com"></label>
          <label v-if="'admin_password' in activeProv" class="flex flex-col gap-1.5"><span class="text-xs text-white/55">管理密码</span><input v-model="activeProv.admin_password" type="text" class="field w-56"></label>
          <label v-if="activeType === 'tempmail_lol'" class="flex flex-col gap-1.5"><span class="text-xs text-white/55">API Key</span><input v-model="activeProv.api_key" type="text" class="field w-56"></label>
        </div>
        <label class="flex flex-col gap-1.5 mt-3"><span class="text-xs text-white/55">域名(每行一个,支持 <code>**.mail.域名.com</code> 通配)</span>
          <textarea v-model="domainText" class="field w-full font-mono text-xs" style="min-height:110px;resize:vertical" placeholder="**.mail.example.com"></textarea></label>
      </template>
      <div class="mt-3"><button @click="saveMail" class="btn-primary">保存邮箱来源</button></div>
    </div>

    <!-- 号池 -->
    <div class="card p-5">
      <h2 class="text-sm font-semibold mb-4 flex items-center gap-2"><Icon name="plug" class="w-4 h-4" /> 邮箱号池
        <span class="pill ml-1" :class="pool.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/10 text-white/50'">{{ pool.ok ? `可用 ${pool.available} / 共 ${pool.total} · 已用 ${pool.used}` : '—' }}</span>
      </h2>
      <textarea v-model="mail.text" placeholder="邮箱账号,每行一个…" class="field w-full font-mono text-xs" style="min-height:96px;resize:vertical"></textarea>
      <div class="flex flex-wrap gap-4 items-end mt-3">
        <label class="flex flex-col gap-1.5"><span class="text-xs text-white/55">邮箱类型</span>
          <select v-model="mail.email_type" class="field w-64"><option value="outlook_oauth">outlook_oauth(Hotmail/Outlook)</option><option value="">自动/其他</option></select>
        </label>
        <label class="flex flex-col gap-1.5"><span class="text-xs text-white/55">生成别名</span>
          <select v-model="mail.gen_alias" class="field w-24"><option :value="false">否</option><option :value="true">是</option></select>
        </label>
        <label v-if="mail.gen_alias" class="flex flex-col gap-1.5"><span class="text-xs text-white/55">每个别名数</span><input v-model="mail.alias_count" type="number" min="1" class="field w-24"></label>
        <button @click="importMail" class="btn-primary">导入号池</button>
        <button @click="refreshPool" class="btn-ghost">刷新统计</button>
      </div>
    </div>

    <!-- 日志 -->
    <div class="card p-5">
      <div class="flex items-center justify-between mb-3"><h2 class="text-sm font-semibold flex items-center gap-2"><Icon name="log" class="w-4 h-4" /> 实时日志</h2>
        <button @click="logs = []" class="btn-ghost">清屏</button></div>
      <div ref="logsBox" class="rounded-lg bg-black/30 ring-1 ring-white/10 p-3 font-mono text-[12px] leading-relaxed overflow-auto" style="height:300px">
        <div v-for="(l, i) in logs" :key="i" :class="logColor(l.level)" class="whitespace-pre-wrap break-all">{{ l.text }}</div>
      </div>
    </div>

    <transition name="fade">
      <div v-if="toast" class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-slate-800 text-white text-sm px-4 py-2.5 ring-1 ring-white/15 shadow-xl">{{ toast }}</div>
    </transition>
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api, jsonBody } from '../api'

const nodes = ref([])
const loaded = ref(false)
let listTimer = null

async function refresh() {
  const r = await api('/cluster-nodes')
  nodes.value = r.data?.data || []
  loaded.value = true
}

const online = computed(() => nodes.value.filter((n) => n.online))
const offlineCount = computed(() => nodes.value.length - online.value.length)
const totalAvailable = computed(() => nodes.value.reduce((s, n) => s + (n.pool_available || 0), 0))
const totalInflight = computed(() => nodes.value.reduce((s, n) => s + (n.in_flight || 0), 0))

const overall = computed(() => {
  if (!nodes.value.length) return { label: '暂无上报节点', tone: 'idle' }
  if (offlineCount.value === 0) return { label: `${online.value.length}/${nodes.value.length} 节点在线`, tone: 'healthy' }
  return { label: `${online.value.length}/${nodes.value.length} 节点在线`, tone: 'warning' }
})

function pill(tone) {
  if (tone === 'healthy') return 'bg-emerald-500/10 text-emerald-500 dark:text-emerald-300 ring-emerald-400/30'
  if (tone === 'warning') return 'bg-amber-500/10 text-amber-600 dark:text-amber-300 ring-amber-400/30'
  return 'bg-[color:var(--hover)] text-[color:var(--fg-3)] ring-[color:var(--hairline)]'
}
function dot(tone) {
  if (tone === 'healthy') return 'bg-emerald-400'
  if (tone === 'warning') return 'bg-amber-400'
  return 'bg-[color:var(--fg-faint)]'
}
function nodePill(n) { return n.online ? pill('healthy') : 'bg-rose-500/10 text-rose-500 dark:text-rose-300 ring-rose-400/30' }
function nodeDot(n) { return n.online ? 'bg-emerald-400' : 'bg-rose-500' }

function fmtSince(s) {
  if (s == null) return '—'
  if (s < 60) return s + '秒前'
  if (s < 3600) return Math.floor(s / 60) + '分前'
  return Math.floor(s / 3600) + '时前'
}
function fmtCpu(n) { return n.cpu_percent ? `${Math.round(n.cpu_percent)}%` : '—' }
function fmtMem(n) {
  if (!n.mem_total_mb) return '—'
  return `${(n.mem_used_mb / 1024).toFixed(1)}/${(n.mem_total_mb / 1024).toFixed(1)}G`
}
function fmtDisk(n) { return n.disk_total_gb ? `${n.disk_used_gb}/${n.disk_total_gb}G` : '—' }

// ===== 节点管理弹窗（注册设置 / 注册日志 / 号池，三个 tab 合一） =====
const modalNode = ref(null)
const modalTab = ref('register')
const reg = ref(null)
const mailStats = ref(null)
const err = ref('')
const busy = ref(false)
let pollTimer = null

const tabs = [
  { key: 'register', label: '注册设置' },
  { key: 'log', label: '注册日志' },
  { key: 'accounts', label: '号池' },
]

async function nodeProxy(method, path, body) {
  const r = await api('/cluster/proxy', jsonBody('POST', {
    node_id: modalNode.value.node_id, method, path, json_body: body || null,
  }))
  if (!r.ok) throw new Error(r.data?.detail || `HTTP ${r.status}`)
  return r.data
}

async function loadReg() {
  try {
    const d = await nodeProxy('GET', '/api/register')
    reg.value = d?.register || null
    err.value = ''
  } catch (e) { err.value = String(e.message || e) }
}
async function loadMailPool() {
  try { mailStats.value = await nodeProxy('GET', '/api/register/mail-pool/stats') } catch { mailStats.value = null }
}
function loadTab() {
  if (modalTab.value === 'accounts') { loadReg(); loadMailPool() }
  else loadReg()
}
function switchTab(t) { modalTab.value = t; loadTab() }

function openNode(node) {
  modalNode.value = node
  modalTab.value = 'register'
  reg.value = null; mailStats.value = null; err.value = ''
  loadTab()
  stopPoll()
  pollTimer = setInterval(() => {
    if (modalNode.value && (modalTab.value === 'register' || modalTab.value === 'log')) loadReg()
  }, 2000)
}
function closeModal() { modalNode.value = null; stopPoll() }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }

async function saveReg() {
  if (!reg.value) return
  busy.value = true
  try {
    const p = {
      total: Number(reg.value.total) || 0,
      target_available: Number(reg.value.target_available) || 0,
      target_quota: Number(reg.value.target_quota) || 0,
      threads: Number(reg.value.threads) || 1,
      check_interval: Number(reg.value.check_interval) || 120,
      mode: reg.value.mode || 'low_watermark',
      proxy: reg.value.proxy || '',
      fixed_password: reg.value.fixed_password || '',
    }
    const d = await nodeProxy('POST', '/api/register', p)
    reg.value = d?.register || reg.value
    err.value = ''
  } catch (e) { err.value = String(e.message || e) }
  busy.value = false
}
async function regAction(action) {
  busy.value = true
  try { await nodeProxy('POST', '/api/register/' + action, {}); await loadReg() }
  catch (e) { err.value = String(e.message || e) }
  busy.value = false
}

const st = computed(() => reg.value?.stats || {})
function logColor(level) {
  if (level === 'red') return 'text-rose-500 dark:text-rose-300'
  if (level === 'green') return 'text-emerald-500 dark:text-emerald-300'
  if (level === 'yellow') return 'text-amber-600 dark:text-amber-300'
  return 'text-[color:var(--fg-2)]'
}

onMounted(() => { refresh(); listTimer = setInterval(refresh, 10000) })
onUnmounted(() => { clearInterval(listTimer); stopPoll() })
</script>

<template>
  <section class="space-y-4 text-[color:var(--fg-2)]">
    <!-- Toolbar -->
    <div class="flex items-center justify-between gap-3">
      <span class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ring-1 tabular-nums"
            :class="pill(overall.tone)">
        <span class="w-1.5 h-1.5 rounded-full" :class="dot(overall.tone)"></span>
        {{ overall.label }}
      </span>
      <button @click="refresh" class="btn-ghost">刷新</button>
    </div>

    <!-- KPI strip -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div class="card p-4">
        <div class="text-xs text-[color:var(--fg-3)]">工作节点</div>
        <div class="text-2xl font-semibold tabular-nums mt-2 text-[color:var(--fg)]">{{ nodes.length }}</div>
        <div class="text-[11px] text-[color:var(--fg-3)] mt-1">{{ online.length }} 在线</div>
      </div>
      <div class="card p-4">
        <div class="text-xs text-[color:var(--fg-3)]">总可用号</div>
        <div class="text-2xl font-semibold tabular-nums mt-2 text-emerald-500 dark:text-emerald-300">{{ totalAvailable }}</div>
        <div class="text-[11px] text-[color:var(--fg-3)] mt-1">各节点可出图账号合计</div>
      </div>
      <div class="card p-4">
        <div class="text-xs text-[color:var(--fg-3)]">在途任务</div>
        <div class="text-2xl font-semibold tabular-nums mt-2 text-[color:var(--fg)]">{{ totalInflight }}</div>
        <div class="text-[11px] text-[color:var(--fg-3)] mt-1">各节点进行中合计</div>
      </div>
      <div class="card p-4">
        <div class="text-xs text-[color:var(--fg-3)]">离线节点</div>
        <div class="text-2xl font-semibold tabular-nums mt-2" :class="offlineCount ? 'text-rose-500 dark:text-rose-300' : 'text-[color:var(--fg)]'">{{ offlineCount }}</div>
        <div class="text-[11px] text-[color:var(--fg-3)] mt-1">心跳超时 / 不健康</div>
      </div>
    </div>

    <!-- Node table -->
    <div class="card">
      <div class="px-5 py-3 border-b border-[color:var(--hairline)] flex items-center justify-between">
        <h2 class="text-sm font-semibold text-[color:var(--fg)]">节点状态</h2>
        <span class="text-[11px] text-[color:var(--fg-3)]">每 10 秒刷新 · 心跳超时即视为离线并停止派单</span>
      </div>
      <div class="p-3 overflow-x-auto">
        <div v-if="loaded && !nodes.length" class="text-center text-xs text-[color:var(--fg-3)] py-8 leading-relaxed">
          暂无节点上报。无头端节点配置 <span class="font-mono">NODE_ID</span> /
          <span class="font-mono">CONTROL_PLANE_URL</span> 后会自动出现在这里。
        </div>
        <div v-else class="space-y-0.5 min-w-[680px]">
          <div v-for="n in nodes" :key="n.node_id"
               class="flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-[color:var(--hover)] transition-colors">
            <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 tabular-nums shrink-0 w-16 justify-center"
                  :class="nodePill(n)">
              <span class="w-1.5 h-1.5 rounded-full" :class="nodeDot(n)"></span>
              {{ n.online ? '在线' : '离线' }}
            </span>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate text-[color:var(--fg)]">
                {{ n.node_id }}
                <span v-if="n.ip_addr" class="text-[color:var(--fg-3)] font-normal ml-1.5 tabular-nums">{{ n.ip_addr }}</span>
              </div>
              <div class="text-[11px] text-[color:var(--fg-3)] mt-0.5 truncate font-mono">{{ n.base_url || '—' }}</div>
            </div>
            <div class="text-right shrink-0 w-16">
              <div class="text-sm tabular-nums" :class="n.pool_available > 0 ? 'text-emerald-500 dark:text-emerald-300' : 'text-rose-500 dark:text-rose-300'">
                {{ n.pool_available }}<span class="text-[color:var(--fg-faint)]">/{{ n.pool_total }}</span>
              </div>
              <div class="text-[10px] text-[color:var(--fg-3)]">可用号</div>
            </div>
            <div class="text-right shrink-0 w-12">
              <div class="text-sm tabular-nums text-[color:var(--fg-2)]">{{ n.in_flight }}</div>
              <div class="text-[10px] text-[color:var(--fg-3)]">在途</div>
            </div>
            <div class="text-right shrink-0 w-12">
              <div class="text-xs tabular-nums text-[color:var(--fg-2)]">{{ fmtCpu(n) }}</div>
              <div class="text-[10px] text-[color:var(--fg-3)]">CPU</div>
            </div>
            <div class="text-right shrink-0 w-20">
              <div class="text-xs tabular-nums text-[color:var(--fg-2)]">{{ fmtMem(n) }}</div>
              <div class="text-[10px] text-[color:var(--fg-3)]">内存</div>
            </div>
            <div class="text-right shrink-0 w-16">
              <div class="text-xs tabular-nums text-[color:var(--fg-2)]">{{ fmtDisk(n) }}</div>
              <div class="text-[10px] text-[color:var(--fg-3)]">磁盘</div>
            </div>
            <div class="text-right shrink-0 w-14">
              <div class="text-xs tabular-nums text-[color:var(--fg-3)]">{{ fmtSince(n.seconds_since_seen) }}</div>
              <div class="text-[10px] text-[color:var(--fg-3)]">心跳</div>
            </div>
            <!-- 操作列：单个管理按钮 -->
            <div class="shrink-0 pl-1 w-16 text-right">
              <button v-if="n.has_provisioner" @click="openNode(n)" class="node-op-primary">管理</button>
              <span v-else class="text-[10px] text-[color:var(--fg-faint)]">无引擎</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 节点管理弹窗 ===== -->
    <div v-if="modalNode" class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" @click="closeModal"></div>
      <div class="relative card w-full max-w-3xl max-h-[85vh] flex flex-col text-[color:var(--fg-2)]">
        <div class="px-5 py-3 border-b border-[color:var(--hairline)] flex items-center justify-between">
          <div>
            <h2 class="text-sm font-semibold text-[color:var(--fg)]">{{ modalNode.node_id }}<span v-if="modalNode.ip_addr" class="text-[color:var(--fg-3)] font-normal ml-2 tabular-nums">{{ modalNode.ip_addr }}</span></h2>
            <div class="text-[11px] text-[color:var(--fg-3)] mt-0.5 font-mono">{{ modalNode.base_url }}</div>
          </div>
          <button @click="closeModal" class="text-[color:var(--fg-3)] hover:text-[color:var(--fg)] text-lg leading-none px-2">✕</button>
        </div>
        <!-- tabs -->
        <div class="px-5 pt-3 flex gap-1">
          <button v-for="t in tabs" :key="t.key" @click="switchTab(t.key)"
                  class="px-3 py-1.5 rounded-lg text-xs transition-colors"
                  :class="modalTab === t.key ? 'bg-[color:var(--hover)] text-[color:var(--fg)] font-medium' : 'text-[color:var(--fg-3)] hover:text-[color:var(--fg)]'">
            {{ t.label }}
          </button>
        </div>

        <div class="p-5 overflow-y-auto flex-1">
          <div v-if="err" class="mb-3 text-xs text-rose-500 dark:text-rose-300 bg-rose-500/10 rounded-lg px-3 py-2 break-all">{{ err }}</div>

          <!-- 注册设置 -->
          <div v-if="modalTab === 'register'">
            <div v-if="!reg" class="text-center text-xs text-[color:var(--fg-3)] py-8">加载中…</div>
            <div v-else class="space-y-4">
              <div class="flex items-center gap-3 flex-wrap">
                <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1"
                      :class="reg.enabled ? 'bg-emerald-500/10 text-emerald-500 dark:text-emerald-300 ring-emerald-400/30' : 'bg-[color:var(--hover)] text-[color:var(--fg-3)] ring-[color:var(--hairline)]'">
                  <span class="w-1.5 h-1.5 rounded-full" :class="reg.enabled ? 'bg-emerald-400' : 'bg-[color:var(--fg-faint)]'"></span>
                  {{ reg.enabled ? '注册运行中' : '已停止' }}
                </span>
                <span class="text-[11px] text-[color:var(--fg-3)] tabular-nums">可用号 {{ st.current_available ?? '—' }} · 进行 {{ st.running ?? 0 }}</span>
                <div class="ml-auto flex gap-2">
                  <button v-if="!reg.enabled" @click="regAction('start')" :disabled="busy" class="node-op-primary">启动</button>
                  <button v-else @click="regAction('stop')" :disabled="busy" class="node-op">停止</button>
                </div>
              </div>
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <label class="block"><span class="fld-l">目标可用号</span><input v-model="reg.target_available" type="number" class="fld"></label>
                <label class="block"><span class="fld-l">每批注册数</span><input v-model="reg.total" type="number" class="fld"></label>
                <label class="block"><span class="fld-l">目标额度</span><input v-model="reg.target_quota" type="number" class="fld"></label>
                <label class="block"><span class="fld-l">并发线程</span><input v-model="reg.threads" type="number" class="fld"></label>
                <label class="block"><span class="fld-l">检查间隔(秒)</span><input v-model="reg.check_interval" type="number" class="fld"></label>
                <label class="block"><span class="fld-l">模式</span>
                  <select v-model="reg.mode" class="fld">
                    <option value="low_watermark">低水位(自动补号)</option>
                    <option value="available">按可用号</option>
                    <option value="quota">按额度</option>
                    <option value="total">按总数</option>
                  </select>
                </label>
              </div>
              <label class="block"><span class="fld-l">代理 URL</span><input v-model="reg.proxy" class="fld font-mono text-[11px]"></label>
              <label class="block"><span class="fld-l">固定密码(可选)</span><input v-model="reg.fixed_password" class="fld"></label>
              <div class="flex justify-end">
                <button @click="saveReg" :disabled="busy" class="node-op-primary">{{ busy ? '保存中…' : '保存设置' }}</button>
              </div>
            </div>
          </div>

          <!-- 注册日志 -->
          <div v-else-if="modalTab === 'log'">
            <div class="flex items-center gap-3 mb-3 text-[11px] text-[color:var(--fg-3)] tabular-nums flex-wrap">
              <span class="text-emerald-500 dark:text-emerald-300">成功 {{ st.success ?? 0 }}</span>
              <span class="text-rose-500 dark:text-rose-300">失败 {{ st.fail ?? 0 }}</span>
              <span class="text-amber-600 dark:text-amber-300">进行 {{ st.running ?? 0 }}</span>
              <span>可用号 {{ st.current_available ?? '—' }}</span>
              <span>成功率 {{ st.success_rate ?? '—' }}%</span>
              <div class="ml-auto flex gap-2">
                <button v-if="!reg?.enabled" @click="regAction('start')" :disabled="busy" class="node-op-primary">开工</button>
                <button v-else @click="regAction('stop')" :disabled="busy" class="node-op">收手</button>
              </div>
            </div>
            <div class="rounded-lg bg-slate-900 ring-1 ring-black/20 p-3 h-80 overflow-y-auto font-mono text-[11px] leading-relaxed">
              <div v-if="!reg?.logs?.length" class="text-white/40">暂无日志</div>
              <div v-for="(l, i) in (reg?.logs || []).slice(-300)" :key="i" :class="logColor(l.level)">
                <span class="text-white/40">{{ (l.time || '').slice(11, 19) }}</span> {{ l.text }}
              </div>
            </div>
          </div>

          <!-- 号池 -->
          <div v-else-if="modalTab === 'accounts'">
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div class="card p-3"><div class="text-[11px] text-[color:var(--fg-3)]">可用号</div><div class="text-xl font-semibold tabular-nums text-emerald-500 dark:text-emerald-300 mt-1">{{ st.current_available ?? '—' }}</div></div>
              <div class="card p-3"><div class="text-[11px] text-[color:var(--fg-3)]">剩余额度</div><div class="text-xl font-semibold tabular-nums mt-1 text-[color:var(--fg)]">{{ st.current_quota ?? '—' }}</div></div>
              <div class="card p-3"><div class="text-[11px] text-[color:var(--fg-3)]">累计成功</div><div class="text-xl font-semibold tabular-nums text-emerald-500 dark:text-emerald-300 mt-1">{{ st.success ?? 0 }}</div></div>
              <div class="card p-3"><div class="text-[11px] text-[color:var(--fg-3)]">累计失败</div><div class="text-xl font-semibold tabular-nums text-rose-500 dark:text-rose-300 mt-1">{{ st.fail ?? 0 }}</div></div>
            </div>
            <div v-if="mailStats" class="card p-3 mt-3">
              <div class="text-[11px] text-[color:var(--fg-3)] mb-1">邮箱号池(Hotmail/outlook)</div>
              <div class="text-sm tabular-nums text-[color:var(--fg)]">可用 {{ mailStats.pool_available ?? 0 }} / 总 {{ mailStats.pool_total ?? 0 }} · 已用 {{ mailStats.pool_used ?? 0 }}</div>
            </div>
            <p class="text-[11px] text-[color:var(--fg-3)] mt-3 leading-relaxed">
              该节点用低水位模式自动维持可用号(号被风控封了会自动补)。详细账号列表后续接入。
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.node-op {
  padding: 0.3rem 0.7rem;
  border-radius: 0.5rem;
  font-size: 11px;
  color: var(--fg-2);
  background: var(--hover);
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}
.node-op:hover { color: var(--fg); filter: brightness(0.97); }
.node-op:disabled { opacity: 0.5; cursor: not-allowed; }
.node-op-primary {
  padding: 0.3rem 0.75rem;
  border-radius: 0.5rem;
  font-size: 11px;
  font-weight: 500;
  color: #fff;
  background: linear-gradient(135deg, #8b5cf6, #d946ef);
  white-space: nowrap;
}
.node-op-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.fld-l { display: block; font-size: 11px; color: var(--fg-3); margin-bottom: 0.25rem; }
.fld {
  width: 100%;
  padding: 0.4rem 0.6rem;
  border-radius: 0.5rem;
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
  border: 1px solid var(--hairline);
  color: var(--fg);
  font-size: 13px;
}
.fld:focus { outline: none; border-color: #a78bfa; }
</style>

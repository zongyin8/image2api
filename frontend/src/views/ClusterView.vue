<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api } from '../api'

const nodes = ref([])
const loaded = ref(false)
let timer = null

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
  if (tone === 'healthy') return 'bg-emerald-500/10 text-emerald-300 ring-emerald-400/30'
  if (tone === 'warning') return 'bg-amber-500/10 text-amber-300 ring-amber-400/30'
  return 'bg-white/5 text-white/50 ring-white/10'
}
function dot(tone) {
  if (tone === 'healthy') return 'bg-emerald-400'
  if (tone === 'warning') return 'bg-amber-400'
  return 'bg-white/40'
}
function nodePill(n) { return n.online ? pill('healthy') : 'bg-rose-500/10 text-rose-300 ring-rose-400/30' }
function nodeDot(n) { return n.online ? 'bg-emerald-400' : 'bg-rose-500' }

function fmtSince(s) {
  if (s == null) return '—'
  if (s < 60) return s + '秒前'
  if (s < 3600) return Math.floor(s / 60) + '分前'
  return Math.floor(s / 3600) + '时前'
}
function fmtMem(n) {
  if (!n.mem_total_mb) return '—'
  return `${n.mem_used_mb || 0}/${n.mem_total_mb} MB`
}

onMounted(() => {
  refresh()
  timer = setInterval(refresh, 10000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <section class="space-y-4">
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
        <div class="text-xs text-white/55">工作节点</div>
        <div class="text-2xl font-semibold tabular-nums mt-2">{{ nodes.length }}</div>
        <div class="text-[11px] text-white/45 mt-1">{{ online.length }} 在线</div>
      </div>
      <div class="card p-4">
        <div class="text-xs text-white/55">总可用号</div>
        <div class="text-2xl font-semibold tabular-nums mt-2 text-emerald-300">{{ totalAvailable }}</div>
        <div class="text-[11px] text-white/45 mt-1">各节点可出图账号合计</div>
      </div>
      <div class="card p-4">
        <div class="text-xs text-white/55">在途任务</div>
        <div class="text-2xl font-semibold tabular-nums mt-2">{{ totalInflight }}</div>
        <div class="text-[11px] text-white/45 mt-1">各节点进行中合计</div>
      </div>
      <div class="card p-4">
        <div class="text-xs text-white/55">离线节点</div>
        <div class="text-2xl font-semibold tabular-nums mt-2" :class="offlineCount ? 'text-rose-300' : ''">{{ offlineCount }}</div>
        <div class="text-[11px] text-white/45 mt-1">心跳超时 / 不健康</div>
      </div>
    </div>

    <!-- Node table -->
    <div class="card">
      <div class="px-5 py-3 border-b border-white/[0.06] flex items-center justify-between">
        <h2 class="text-sm font-semibold">节点状态</h2>
        <span class="text-[11px] text-white/45">每 10 秒刷新 · 心跳超时即视为离线并停止派单</span>
      </div>
      <div class="p-3">
        <div v-if="loaded && !nodes.length" class="text-center text-xs text-white/40 py-8 leading-relaxed">
          暂无节点上报。<br>
          无头端节点配置 <span class="font-mono text-white/60">NODE_ID</span> /
          <span class="font-mono text-white/60">NODE_BASE_URL</span> /
          <span class="font-mono text-white/60">CONTROL_PLANE_URL</span> 后会自动出现在这里。
        </div>
        <div v-else class="space-y-0.5">
          <div v-for="n in nodes" :key="n.node_id"
               class="flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-white/[0.04] transition-colors">
            <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 tabular-nums shrink-0 w-16 justify-center"
                  :class="nodePill(n)">
              <span class="w-1.5 h-1.5 rounded-full" :class="nodeDot(n)"></span>
              {{ n.online ? '在线' : '离线' }}
            </span>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate">{{ n.node_id }}</div>
              <div class="text-[11px] text-white/45 mt-0.5 truncate font-mono">{{ n.base_url || '—' }}</div>
            </div>
            <div class="text-right shrink-0 w-20">
              <div class="text-sm tabular-nums" :class="n.pool_available > 0 ? 'text-emerald-300' : 'text-rose-300'">
                {{ n.pool_available }}<span class="text-white/30">/{{ n.pool_total }}</span>
              </div>
              <div class="text-[10px] text-white/40">可用号</div>
            </div>
            <div class="text-right shrink-0 w-14">
              <div class="text-sm tabular-nums">{{ n.in_flight }}</div>
              <div class="text-[10px] text-white/40">在途</div>
            </div>
            <div class="text-right shrink-0 w-24 hidden sm:block">
              <div class="text-xs tabular-nums text-white/70">{{ fmtMem(n) }}</div>
              <div class="text-[10px] text-white/40">内存</div>
            </div>
            <div class="text-right shrink-0 w-16">
              <div class="text-xs tabular-nums text-white/60">{{ fmtSince(n.seconds_since_seen) }}</div>
              <div class="text-[10px] text-white/40">心跳</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Node errors -->
    <div v-if="nodes.some((n) => n.last_error)" class="card">
      <div class="px-5 py-3 border-b border-white/[0.06]">
        <h2 class="text-sm font-semibold">节点错误</h2>
      </div>
      <div class="p-3 space-y-1">
        <div v-for="n in nodes.filter((x) => x.last_error)" :key="n.node_id"
             class="flex items-start gap-2 px-2 py-1.5 text-xs">
          <span class="font-mono text-white/70 shrink-0">{{ n.node_id }}</span>
          <span class="text-rose-300 break-all">{{ n.last_error }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

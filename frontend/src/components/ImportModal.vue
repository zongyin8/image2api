<script setup>
import { ref, computed } from 'vue'
import { api, jsonBody } from '../api'
import { parseImportInput } from '../utils/import'
import Icon from './Icon.vue'

const emit = defineEmits(['close', 'imported'])
const props = defineProps({ single: { type: Boolean, default: false } })

const input = ref('')
const weight = ref(0)
const proxyURL = ref('')
const status = ref('')
const isError = ref(false)
const submitting = ref(false)

// Live preview of what the parser would extract — updates as the user types
// so they can see whether their paste was understood before clicking import.
const detected = computed(() => {
  const items = parseImportInput(input.value)
  const openai = items.filter((x) => x.type === 'openai').length
  const adobe = items.filter((x) => x.type === 'adobe').length
  const runway = items.filter((x) => x.type === 'runway').length
  const leonardo = items.filter((x) => x.type === 'leonardo').length
  const krea = items.filter((x) => x.type === 'krea').length
  const imagine = items.filter((x) => x.type === 'imagine').length
  const grok = items.filter((x) => x.type === 'grok').length
  return { total: items.length, openai, adobe, runway, leonardo, krea, imagine, grok }
})

function setStatus(text, err = false) {
  status.value = text || ''
  isError.value = err
}

async function doSmartImport() {
  const items = parseImportInput(input.value)
  if (!items.length) {
    setStatus('未识别到任何 Cookie 或 JWT', true)
    return
  }
  if (props.single && items.length !== 1) {
    setStatus('添加账号只支持单个账号，请只粘贴一份 Cookie、Token 或 JSON', true)
    return
  }
  submitting.value = true
  let ok = 0, fail = 0
  const errs = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const common = {
      proxy_url: proxyURL.value.trim(),
      weight: Number(weight.value) || 0,
    }
    try {
      const r = it.type === 'openai'
        ? await api('/tokens/import-chatgpt-token', jsonBody('POST', { access_token: it.value, ...common }))
        : it.type === 'grok'
          ? await api('/tokens/import-grok-token', jsonBody('POST', { access_token: it.value, ...common }))
        : it.type === 'runway'
          ? await api('/tokens/import-runway-token', jsonBody('POST', { access_token: it.value, ...common }))
          : it.type === 'leonardo'
            ? await api('/tokens/import-leonardo-cookie', jsonBody('POST', { cookie: it.value, ...common }))
            : it.type === 'krea'
              ? await api('/tokens/import-krea-cookie', jsonBody('POST', { cookie: it.value, ...common }))
              : it.type === 'imagine'
                ? await api('/tokens/import-imagine-token', jsonBody('POST', { value: it.value, ...common }))
                : await api('/tokens/import-adobe-cookie', jsonBody('POST', { cookie: it.value, ...common }))
      if (r.ok) {
        ok++
      } else { fail++; errs.push(`${it.type}: ${r.data?.detail || r.status}`) }
    } catch (e) {
      fail++; errs.push(`${it.type}: ${e}`)
    }
  }
  submitting.value = false
  // Quota isn't checked here — the server probes each token off-thread and the
  // account list flips pending → active/dead on its own.
  if (fail === 0) {
    // Close immediately on success — the account lands in the table right away
    // and the server backfills quota/email off-thread (pending → active/dead).
    emit('imported')
    emit('close')
  } else {
    setStatus(`成功 ${ok} · 失败 ${fail} · ${errs.slice(0, 3).join(' | ')}`, true)
    emit('imported')
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4"
       @click.self="emit('close')">
    <div class="card !shadow-xl mt-14 mb-14 w-full max-w-2xl">
      <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <h2 class="text-sm font-semibold">{{ single ? '添加账号' : '导入账号' }}</h2>
        <button @click="emit('close')" class="text-slate-400 hover:text-slate-700 transition-colors">
          <Icon name="close" class="w-5 h-5" />
        </button>
      </div>

      <div class="p-5">
        <p v-if="single" class="text-xs text-slate-500 mb-3">仅支持单个账号，代理会在账号进入后台校验和调度前保存。</p>
        <p class="text-xs text-slate-500 mb-3 leading-relaxed">自动识别：
          <strong class="text-slate-700">Adobe Cookie 字符串</strong>(<code class="px-1 bg-slate-100 rounded">k=v; k=v; ...</code>)、
          <strong class="text-slate-700">Cookie JSON 对象</strong>、
          <strong class="text-slate-700">Cookie 数组</strong>(多 Adobe 批量)、
          <strong class="text-slate-700">ChatGPT JWT</strong>(<code class="px-1 bg-slate-100 rounded">eyJhbGciOi...</code>)、
          <strong class="text-slate-700">Runway JWT</strong>(自动与 ChatGPT 区分)、
          <strong class="text-slate-700">Leonardo Cookie</strong>(含 better-auth)、
          <strong class="text-slate-700">Krea Cookie</strong>(含 sb-superb-auth)、
          <strong class="text-slate-700">Imagine Token</strong>(<code class="px-1 bg-slate-100 rounded">{"token","refreshToken","email","parentId"}</code>)、
          <strong class="text-slate-700">Grok SSO</strong>(grok.com 的 <code class="px-1 bg-slate-100 rounded">sso</code> 值,仅含 session_id,自动与 ChatGPT/Runway 区分)、
          <strong class="text-slate-700">多个 JWT</strong>(换行分隔)。
          全粘进来即可，无需任何前缀。
        </p>
        <textarea v-model="input" :rows="single ? 7 : 10"
                  class="field font-mono text-xs resize-none"
                  placeholder="直接粘 Cookie 字符串 / JWT / JSON，自动识别"></textarea>
        <div v-if="input.trim()" class="mt-2 flex items-center gap-2 text-xs">
          <template v-if="detected.total">
            <span class="text-emerald-600">✓ 识别到 <strong class="tabular-nums">{{ detected.total }}</strong> 个账号</span>
            <span v-if="detected.openai" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-emerald-700 bg-emerald-50 ring-1 ring-emerald-200">
              OpenAI · <span class="tabular-nums">{{ detected.openai }}</span>
            </span>
            <span v-if="detected.adobe" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-rose-700 bg-rose-50 ring-1 ring-rose-200">
              Adobe · <span class="tabular-nums">{{ detected.adobe }}</span>
            </span>
            <span v-if="detected.runway" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-violet-700 bg-violet-50 ring-1 ring-violet-200">
              Runway · <span class="tabular-nums">{{ detected.runway }}</span>
            </span>
            <span v-if="detected.leonardo" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-amber-700 bg-amber-50 ring-1 ring-amber-200">
              Leonardo · <span class="tabular-nums">{{ detected.leonardo }}</span>
            </span>
            <span v-if="detected.krea" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-sky-700 bg-sky-50 ring-1 ring-sky-200">
              Krea · <span class="tabular-nums">{{ detected.krea }}</span>
            </span>
            <span v-if="detected.imagine" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-teal-700 bg-teal-50 ring-1 ring-teal-200">
              Imagine · <span class="tabular-nums">{{ detected.imagine }}</span>
            </span>
            <span v-if="detected.grok" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-slate-700 bg-slate-100 ring-1 ring-slate-300">
              Grok · <span class="tabular-nums">{{ detected.grok }}</span>
            </span>
          </template>
          <span v-else class="text-rose-600">未识别到任何 Cookie 或 JWT</span>
        </div>
        <p v-if="single && detected.total > 1" class="mt-2 text-xs text-rose-600">添加账号只支持单个账号，请减少为一份凭据。</p>
        <div class="mt-3 grid gap-3 sm:grid-cols-[1fr_7rem]">
          <div>
            <label class="text-xs text-slate-500">账号代理 <span class="text-slate-400">(可选，留空使用节点全局代理)</span></label>
            <input v-model="proxyURL" class="field font-mono text-xs" placeholder="socks5://user:pass@host:port" />
          </div>
          <div>
            <label class="text-xs text-slate-500">权重</label>
            <input v-model.number="weight" type="number" min="0" max="10000" class="field" placeholder="0" />
          </div>
        </div>
        <button @click="doSmartImport" :disabled="submitting || !detected.total || (single && detected.total !== 1)" class="btn-primary w-full mt-3">
          {{ submitting ? (single ? '添加中…' : '导入中…') : (single ? '识别并添加' : (detected.total ? `识别并导入 (${detected.total})` : '识别并导入')) }}
        </button>
        <p v-if="status" class="text-xs mt-2" :class="isError ? 'text-rose-600' : 'text-emerald-600'">{{ status }}</p>
      </div>
    </div>
  </div>
</template>

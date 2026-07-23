<script setup>
import { ref, onMounted } from 'vue'
import { api, jsonBody } from '../api'
import Icon from './Icon.vue'

const props = defineProps({ account: { type: Object, default: null } }) // edit mode when set
const emit = defineEmits(['close', 'imported'])

const isEdit = !!props.account
const name = ref(props.account?.email || '')
const baseUrl = ref(props.account?.base_url || '')
const key = ref('')            // edit: blank = keep existing key
const allModels = ref([])      // existing models to pick from
const selected = ref(props.account?.models ? String(props.account.models).split(',').map((x) => x.trim()).filter(Boolean) : [])
// An empty model list deliberately means "all existing model ids" on the
// backend. Keep that as the safe default so OpenAI-compatible upstreams can
// take over built-in ids such as gpt-image-2 without creating duplicate models.
const limitModels = ref(selected.value.length > 0)
const weight = ref(Number(props.account?.weight) || 0)
const concurrency = ref(Number(props.account?.concurrency) || 1)
const proxyURL = ref(props.account?.proxy_url || '')
const status = ref('')
const isError = ref(false)
const submitting = ref(false)

onMounted(async () => {
  try {
    const r = await api('/managed-models')
    allModels.value = (r.data?.data || []).map((m) => ({ id: m.id, type: m.type, alias: m.alias }))
  } catch (_) {}
})

function toggle(id) {
  const i = selected.value.indexOf(id)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(id)
}

async function submit() {
  if (!baseUrl.value.trim() || (!isEdit && !key.value.trim())) {
    status.value = isEdit ? '请填写 URL' : '请填写 URL 和 Key'; isError.value = true; return
  }
  submitting.value = true; status.value = ''; isError.value = false
  try {
    const r = await api('/tokens/import-custom-account', jsonBody('POST', {
      id: isEdit ? props.account.id : undefined,
      name: name.value.trim(),
      base_url: baseUrl.value.trim(),
      key: key.value.trim(),       // blank in edit = keep existing
      protocol: 'openai',
      models: limitModels.value ? selected.value.join(',') : '',
      weight: Number(weight.value) || 0,
      concurrency: Number(concurrency.value) || 1,
      proxy_url: proxyURL.value.trim(),
    }))
    if (r.ok) {
      status.value = isEdit ? '✓ 已保存' : '✓ 已添加上游'; emit('imported')
      setTimeout(() => emit('close'), 700)
    } else {
      status.value = r.data?.detail || '保存失败'; isError.value = true
    }
  } catch (e) {
    status.value = String(e); isError.value = true
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4"
       @click.self="emit('close')">
    <div class="card !shadow-xl mt-14 mb-14 w-full max-w-lg">
      <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <h2 class="text-sm font-semibold">{{ isEdit ? '编辑上游' : '添加自定义上游' }}</h2>
        <button @click="emit('close')" class="text-slate-400 hover:text-slate-700 transition-colors">
          <Icon name="close" class="w-5 h-5" />
        </button>
      </div>
      <div class="p-5 space-y-3">
        <p class="text-xs text-slate-500 leading-relaxed">
          这是 OpenAI 兼容上游:填基础 URL + Key 即可。已有模型(例如 <code class="text-slate-700">gpt-image-2</code>)会按
          <strong class="text-slate-700">模型 id</strong>自动路由,无需在「模型管理」重复创建同名模型。默认接管所有已有模型;
          代理留空时直连。
        </p>
        <div>
          <label class="text-xs text-slate-500">备注名</label>
          <input v-model="name" class="field" placeholder="例如:我的中转 / xx-api" />
        </div>
        <div>
          <label class="text-xs text-slate-500">v1 URL <span class="text-rose-500">*</span></label>
          <input v-model="baseUrl" class="field font-mono text-xs" placeholder="https://api.example.com(无需 /v1 结尾)" />
        </div>
        <div>
          <label class="text-xs text-slate-500">Key <span v-if="!isEdit" class="text-rose-500">*</span><span v-else class="text-white/40">(留空=不改)</span></label>
          <input v-model="key" class="field font-mono text-xs" :placeholder="isEdit ? '留空保持原 key' : 'sk-...'" />
        </div>
        <div>
          <label class="text-xs text-slate-500">账号代理 <span class="text-slate-400">(可选，留空直连)</span></label>
          <input v-model="proxyURL" class="field font-mono text-xs" placeholder="socks5://user:pass@host:port" />
        </div>
        <div>
          <label class="flex items-center gap-2 text-xs text-slate-500 mb-1.5 cursor-pointer">
            <input v-model="limitModels" type="checkbox" class="accent-indigo-500" />
            仅限制到指定模型(可选)
            <span class="text-[11px] text-slate-400">{{ limitModels ? `已选 ${selected.length}` : '默认接管已有模型' }}</span>
          </label>
          <div v-if="limitModels && !allModels.length" class="text-xs text-slate-400 rounded-lg ring-1 ring-slate-200 bg-slate-50/60 p-3">
            暂无可选模型。关闭此选项即可按模型 id 自动接管已有模型。
          </div>
          <div v-else-if="limitModels" class="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto rounded-lg ring-1 ring-slate-200 bg-slate-50/60 p-2">
            <button v-for="m in allModels" :key="m.id" type="button" @click="toggle(m.id)"
                    class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs ring-1 transition-colors"
                    :class="selected.includes(m.id) ? 'bg-indigo-500/15 text-indigo-700 ring-indigo-300 font-medium' : 'bg-white text-slate-600 ring-slate-200 hover:ring-slate-300'">
              <span class="w-1.5 h-1.5 rounded-full" :class="m.type === 'video' ? 'bg-violet-400' : 'bg-emerald-400'"></span>{{ m.alias || m.id }}
            </button>
          </div>
        </div>
        <div class="flex gap-3">
          <div class="flex-1">
            <label class="text-xs text-slate-500">权重(高的优先)</label>
            <input v-model.number="weight" type="number" class="field" placeholder="0" />
          </div>
          <div class="flex-1">
            <label class="text-xs text-slate-500">并发数(单账号)</label>
            <input v-model.number="concurrency" type="number" min="1" class="field" placeholder="1" />
          </div>
        </div>
        <button @click="submit" :disabled="submitting" class="btn-primary w-full mt-1">
          {{ submitting ? '保存中…' : (isEdit ? '保存' : '添加上游') }}
        </button>
        <p v-if="status" class="text-xs" :class="isError ? 'text-rose-600' : 'text-emerald-600'">{{ status }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { api, jsonBody } from '../api'
import Icon from './Icon.vue'

const props = defineProps({ ids: { type: Array, required: true } })
const emit = defineEmits(['close', 'saved'])

const changeProxy = ref(true)
const proxyURL = ref('')
const changeWeight = ref(false)
const weight = ref(0)
const changeStatus = ref(false)
const accountStatus = ref('active')
const status = ref('')
const isError = ref(false)
const submitting = ref(false)
const hasChange = computed(() => changeProxy.value || changeWeight.value || changeStatus.value)

async function submit() {
  if (!hasChange.value) {
    status.value = '请至少选择一项要修改的设置'
    isError.value = true
    return
  }
  const payload = { ids: props.ids }
  if (changeProxy.value) payload.proxy_url = proxyURL.value.trim()
  if (changeWeight.value) payload.weight = Number(weight.value) || 0
  if (changeStatus.value) payload.status = accountStatus.value

  submitting.value = true
  status.value = ''
  isError.value = false
  try {
    const r = await api('/tokens/update-bulk', jsonBody('POST', payload))
    if (!r.ok) {
      status.value = r.data?.detail || '批量保存失败'
      isError.value = true
      return
    }
    status.value = `已更新 ${r.data?.updated ?? props.ids.length} 个账号`
    emit('saved')
    setTimeout(() => emit('close'), 600)
  } catch (e) {
    status.value = String(e)
    isError.value = true
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
       @click.self="emit('close')">
    <div class="card !shadow-2xl my-12 w-full max-w-lg">
      <div class="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
        <div>
          <h2 class="text-sm font-semibold">批量编辑账号</h2>
          <p class="mt-1 text-[11px] text-white/40">已选择 {{ ids.length }} 个账号</p>
        </div>
        <button @click="emit('close')" class="text-white/40 hover:text-white" title="关闭">
          <Icon name="close" class="w-5 h-5" />
        </button>
      </div>

      <div class="p-5 space-y-4">
        <div class="setting-row">
          <label class="setting-toggle">
            <input v-model="changeProxy" type="checkbox" class="chk" />
            <span>修改账号代理</span>
          </label>
          <input v-model="proxyURL" :disabled="!changeProxy" class="field font-mono text-xs"
                 placeholder="留空可批量恢复使用节点全局代理" />
          <p class="hint">支持 HTTP、HTTPS、SOCKS5。只影响选中账号。</p>
        </div>

        <div class="setting-row">
          <label class="setting-toggle">
            <input v-model="changeWeight" type="checkbox" class="chk" />
            <span>修改权重</span>
          </label>
          <input v-model.number="weight" :disabled="!changeWeight" type="number" min="0" max="10000" class="field" />
        </div>

        <div class="setting-row">
          <label class="setting-toggle">
            <input v-model="changeStatus" type="checkbox" class="chk" />
            <span>修改状态</span>
          </label>
          <select v-model="accountStatus" :disabled="!changeStatus" class="field">
            <option value="active">启用</option>
            <option value="disabled">禁用</option>
          </select>
        </div>

        <p v-if="status" class="text-xs" :class="isError ? 'text-rose-400' : 'text-emerald-400'">{{ status }}</p>
        <div class="flex justify-end gap-2 pt-1">
          <button @click="emit('close')" class="btn-soft">取消</button>
          <button @click="submit" :disabled="submitting || !hasChange" class="btn-primary">
            {{ submitting ? '保存中…' : '应用到选中账号' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.setting-row {
  display: grid;
  gap: 0.5rem;
}
.setting-toggle {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.76rem;
  font-weight: 500;
  color: rgb(255 255 255 / 0.75);
}
.hint {
  font-size: 0.68rem;
  line-height: 1.45;
  color: rgb(255 255 255 / 0.35);
}
.field:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>

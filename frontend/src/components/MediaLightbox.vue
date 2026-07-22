<script setup>
// Full-screen preview: the enlarged image/video on a dark backdrop, plus a
// small top-right action row (copy-to-clipboard for images, download for
// both). Click the dark area (or Esc, handled by the parent) to close.
import { ref, watch, nextTick } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  src: { type: String, required: true },     // resolved media URL
  kind: { type: String, default: 'image' },  // 'image' | 'video'
  prompt: { type: String, default: '' },
  meta: { type: String, default: '' },
  metaSub: { type: String, default: '' },
  downloadName: { type: String, default: '' },
  editable: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'edit'])

// Render the image as a CSS background (not <img>) so Edge/Bing shows no
// "visual search" hover icon. Load it to learn its aspect ratio, then size the
// div to fit the viewport while preserving ratio — mirrors object-contain.
const imgRatio = ref(1)
const imageSurface = ref(null)
const editMode = ref(false)
const points = ref([])
const overallInstruction = ref('')
const submitting = ref(false)
watch(() => props.src, (src) => {
  if (props.kind !== 'image' || !src) return
  const im = new Image()
  im.onload = () => { if (im.naturalHeight) imgRatio.value = im.naturalWidth / im.naturalHeight }
  im.src = src
}, { immediate: true })

watch(() => props.src, () => resetEditor())

function resetEditor() {
  editMode.value = false
  points.value = []
  overallInstruction.value = ''
  submitting.value = false
}

function toggleEditor() {
  if (!props.editable || props.kind === 'video') return
  editMode.value = !editMode.value
  if (!editMode.value) {
    points.value = []
    overallInstruction.value = ''
  }
}

async function addPoint(ev) {
  if (!editMode.value || !imageSurface.value) return
  const rect = imageSurface.value.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const x = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100))
  const y = Math.max(0, Math.min(100, ((ev.clientY - rect.top) / rect.height) * 100))
  points.value.push({ x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), text: '' })
  await nextTick()
  const inputs = document.querySelectorAll('[data-point-edit-input]')
  inputs[inputs.length - 1]?.focus()
}

function removePoint(index) {
  points.value.splice(index, 1)
}

function focusPoint(index) {
  document.querySelectorAll('[data-point-edit-input]')[index]?.focus()
}

function buildEditPrompt() {
  const localized = points.value
    .filter((point) => point.text.trim())
    .map((point, index) => `${index + 1}. (x: ${point.x.toFixed(1)}%, y: ${point.y.toFixed(1)}%) ${point.text.trim()}`)
  const overall = overallInstruction.value.trim()
  return [...localized, ...(overall ? [overall] : [])].join('\n\n')
}

async function submitEdit() {
  const editPrompt = buildEditPrompt()
  if (!editPrompt) { flash('请填写至少一条修改意见'); return }
  submitting.value = true
  emit('edit', { src: props.src, prompt: editPrompt })
}

const toast = ref('')
let toastTimer = null
function flash(msg) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 1800)
}

async function copyImage() {
  try {
    const blob = await (await fetch(props.src)).blob()
    const pngBlob = blob.type === 'image/png'
      ? blob
      : await new Promise((resolve, reject) => {
          createImageBitmap(blob).then((bitmap) => {
            const canvas = document.createElement('canvas')
            canvas.width = bitmap.width
            canvas.height = bitmap.height
            const ctx = canvas.getContext('2d')
            if (!ctx) { reject(new Error('no canvas ctx')); return }
            ctx.drawImage(bitmap, 0, 0)
            canvas.toBlob((out) => {
              if (out) resolve(out)
              else reject(new Error('png convert failed'))
            }, 'image/png')
          }).catch(reject)
        })
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
    flash('图片已复制')
  } catch {
    flash('复制失败')
  }
}
</script>

<template>
  <!-- Teleport to <body> so the overlay escapes the layout's `main` (relative
       z-10) stacking context — otherwise the fixed z-index sits BELOW the
       root-level sidebar (z-30) and the logo pokes through the backdrop. -->
  <Teleport to="body">
  <transition name="lb-fade" appear>
    <div class="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4"
         @click.self="emit('close')">
      <video v-if="kind === 'video'" :src="src" controls autoplay
             class="max-h-[94vh] max-w-[96vw] rounded-lg"
             controlslist="nodownload noremoteplayback noplaybackrate"
             disablepictureinpicture disableremoteplayback></video>
      <div v-else ref="imageSurface" @click="addPoint"
           :style="{ width: `min(96vw, calc(${editMode ? '68vh' : '94vh'} * ${imgRatio}))`, aspectRatio: imgRatio, backgroundImage: `url(${src})` }"
           class="relative rounded-lg bg-contain bg-center bg-no-repeat"
           :class="editMode ? 'cursor-crosshair ring-1 ring-white/20' : ''">
        <button v-for="(point, index) in points" :key="index" type="button"
                @click.stop="focusPoint(index)"
                :style="{ left: `${point.x}%`, top: `${point.y}%` }"
                class="absolute -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black text-white border-2 border-white shadow-lg text-xs font-bold grid place-items-center">
          {{ index + 1 }}
        </button>
      </div>

      <!-- actions: copy (images only) + download -->
      <div class="absolute top-4 right-4 flex gap-2">
        <button v-if="editable && kind !== 'video'" @click.stop="toggleEditor" title="局部编辑"
                class="w-9 h-9 rounded-lg ring-1 text-white grid place-items-center"
                :class="editMode ? 'bg-white text-slate-900 ring-white' : 'bg-black/60 ring-white/15 hover:bg-black/80'">
          <Icon name="edit" class="w-4 h-4" />
        </button>
        <button v-if="kind !== 'video'" @click.stop="copyImage" title="复制图片"
                class="w-9 h-9 rounded-lg bg-black/60 ring-1 ring-white/15 hover:bg-black/80 text-white grid place-items-center">
          <Icon name="copy" class="w-4 h-4" />
        </button>
        <a :href="src" :download="downloadName || src.split('/').pop()" @click.stop title="下载"
           class="w-9 h-9 rounded-lg bg-black/60 ring-1 ring-white/15 hover:bg-black/80 text-white grid place-items-center">
          <Icon name="download" class="w-4 h-4" />
        </a>
        <button @click.stop="emit('close')" title="关闭"
                class="w-9 h-9 rounded-lg bg-black/60 ring-1 ring-white/15 hover:bg-black/80 text-white grid place-items-center">
          <Icon name="close" class="w-4 h-4" />
        </button>
      </div>

      <div v-if="editMode" @click.stop
           class="absolute inset-x-3 bottom-3 mx-auto max-w-3xl bg-white text-slate-900 rounded-lg shadow-2xl ring-1 ring-black/10 p-3 sm:p-4">
        <div class="flex items-center justify-between gap-3 mb-2">
          <div class="text-sm font-semibold">{{ points.length }} 条局部修改</div>
          <div class="text-xs text-slate-500">点击图片添加标记</div>
        </div>
        <div v-if="points.length" class="max-h-32 overflow-y-auto space-y-2 pr-1">
          <div v-for="(point, index) in points" :key="index" class="flex items-center gap-2">
            <span class="shrink-0 w-6 h-6 rounded-full bg-slate-900 text-white text-[11px] font-bold grid place-items-center">{{ index + 1 }}</span>
            <span class="hidden sm:inline shrink-0 text-[10px] font-mono text-slate-400">{{ point.x.toFixed(1) }}%, {{ point.y.toFixed(1) }}%</span>
            <input v-model="point.text" data-point-edit-input type="text" placeholder="描述这里需要怎么改"
                   class="min-w-0 flex-1 h-9 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-slate-500" />
            <button type="button" @click="removePoint(index)" title="删除标记"
                    class="shrink-0 w-8 h-8 rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600 grid place-items-center">
              <Icon name="close" class="w-4 h-4" />
            </button>
          </div>
        </div>
        <div v-else class="h-10 grid place-items-center text-xs text-slate-400 border border-dashed border-slate-200 rounded-md">
          在图片上点击需要修改的位置
        </div>
        <div class="flex gap-2 mt-2">
          <input v-model="overallInstruction" type="text" placeholder="可选：补充整体修改要求"
                 class="min-w-0 flex-1 h-10 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-slate-500"
                 @keydown.enter.prevent="submitEdit" />
          <button type="button" @click="submitEdit" :disabled="submitting"
                  class="h-10 px-4 rounded-md bg-slate-950 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50">
            {{ submitting ? '提交中' : '生成' }}
          </button>
        </div>
      </div>

      <div v-if="toast"
           class="absolute bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-xs px-4 py-2 rounded-lg shadow-lg">
        {{ toast }}
      </div>
    </div>
  </transition>
  </Teleport>
</template>

<style scoped>
.lb-fade-enter-active, .lb-fade-leave-active { transition: opacity 0.18s ease; }
.lb-fade-enter-from, .lb-fade-leave-to { opacity: 0; }
</style>

// Reactive draft of the 画图 form fields. Lives at module scope so the
// values survive PlaygroundView being unmounted (navigation to 首页/记录 etc.)
// and remounted — without this, switching away and back wiped the prompt
// and selected model. Persist the small text/option draft so a full browser
// refresh does not wipe work in progress. Reference image blobs live in
// IndexedDB instead (see utils/draftStorage.js).
import { reactive, watch } from 'vue'

const DRAFT_KEY = 'image2api_playground_draft_v1'

function loadDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}')
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    localStorage.removeItem(DRAFT_KEY)
    return {}
  }
}

const saved = loadDraft()

export const draft = reactive({
  mode: saved.mode || '',           // 'image' | 'video'
  modelId: saved.modelId || '',
  prompt: saved.prompt || '',
  ratio: saved.ratio || '',
  resolution: saved.resolution || '',
  duration: saved.duration || '',
  deai: !!saved.deai,
})

watch(draft, (value) => {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(value)) } catch { /* storage unavailable */ }
}, { deep: true })

// Copy fields from a server-side job entry (the `/jobs/mine` payload) into
// the draft so a parallel tab can pick up exactly what's being generated.
export function applyJobToDraft(entry) {
  if (!entry) return
  draft.mode = entry.kind === 'video' ? 'video' : 'image'
  draft.modelId = entry.model || ''
  draft.prompt = entry.prompt || ''
  draft.ratio = entry.ratio || ''
  draft.resolution = entry.resolution || ''
  draft.duration = entry.duration || ''
}

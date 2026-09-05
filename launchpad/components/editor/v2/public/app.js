const title = document.querySelector('#project-title')
const preview = document.querySelector('#preview-link')
const fileList = document.querySelector('#file-list')
const newFileForm = document.querySelector('#new-file-form')
const newFile = document.querySelector('#new-file')
const currentPath = document.querySelector('#current-path')
const content = document.querySelector('#content')
const save = document.querySelector('#save')
const status = document.querySelector('#status')

let selectedPath = null
let baseRevision = null
let openSequence = 0

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options })
  const payload = await response.json()
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload.data ?? payload
}

function setStatus(message, kind = 'neutral') {
  status.textContent = message
  status.dataset.kind = kind
}

function addFileOption(path) {
  if ([...fileList.options].some((option) => option.value === path)) return
  const option = document.createElement('option')
  option.value = path
  option.textContent = path
  fileList.appendChild(option)
}

async function loadState() {
  const state = await api('/api/state')
  title.textContent = `${state.projectTitle} Editor`
  document.title = `${state.projectTitle} Editor`
  preview.href = state.previewBaseUrl
  for (const path of state.files) addFileOption(path)
}

async function openFile(path) {
  const sequence = ++openSequence
  selectedPath = null
  baseRevision = null
  currentPath.textContent = path
  content.value = ''
  content.disabled = true
  save.disabled = true
  setStatus('Načítám…')
  try {
    const file = await api(`/api/file?path=${encodeURIComponent(path)}`)
    if (sequence !== openSequence || fileList.value !== path) return
    if (file.path !== path) throw new Error('Server vrátil jiný soubor, než byl vybrán.')
    selectedPath = file.path
    baseRevision = file.revision
    currentPath.textContent = file.path
    content.value = file.content
    content.disabled = false
    save.disabled = false
    setStatus('Načteno', 'ok')
  } catch (error) {
    if (sequence === openSequence && fileList.value === path) {
      setStatus(error.message, 'error')
    }
  }
}

fileList.addEventListener('change', () => {
  if (fileList.value) openFile(fileList.value)
})

newFileForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const path = newFile.value.trim()
  if (!path) return
  openSequence += 1
  addFileOption(path)
  fileList.value = path
  selectedPath = path
  baseRevision = null
  currentPath.textContent = path
  content.value = ''
  content.disabled = false
  save.disabled = false
  newFile.value = ''
  setStatus('Nový lokální Draft')
})

save.addEventListener('click', async () => {
  if (!selectedPath) return
  save.disabled = true
  setStatus('Ukládám…')
  try {
    const saved = await api('/api/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: selectedPath, content: content.value, baseRevision }),
    })
    baseRevision = saved.revision
    addFileOption(saved.path)
    fileList.value = saved.path
    setStatus('Draft uložen', 'ok')
  } catch (error) {
    setStatus(error.message, 'error')
  } finally {
    save.disabled = false
  }
})

loadState().catch((error) => setStatus(error.message, 'error'))

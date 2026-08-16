import { defineStore } from 'pinia'
import { ref } from 'vue'

let seq = 0

export const useUiStore = defineStore('ui', () => {
  const toasts = ref([])
  const busy = ref(null) // { text, progress }
  const confirmState = ref(null) // { title, message, confirmText, cancelText, danger, resolve }

  function toast(text, type = 'info', duration = 2600) {
    const id = ++seq
    toasts.value.push({ id, text, type })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, duration)
    return id
  }

  const ok = (t) => toast(t, 'success')
  const err = (t) => toast(t, 'error', 4200)
  const warn = (t) => toast(t, 'warn', 3600)

  function setBusy(text, progress = null) {
    busy.value = text ? { text, progress } : null
  }

  /**
   * 应用内确认弹窗（替代原生 window.confirm）。
   * 原生 confirm 在预览面板 / 沙箱 iframe 里会被浏览器静默拦截，导致按钮「点了没反应」。
   * 返回一个 Promise<boolean>。
   */
  function confirm(opts) {
    return new Promise((resolve) => {
      confirmState.value = {
        title: opts.title || '请确认',
        message: opts.message || '',
        confirmText: opts.confirmText || '确定',
        cancelText: opts.cancelText || '取消',
        danger: opts.danger || false,
        resolve,
      }
    })
  }

  function resolveConfirm(value) {
    const s = confirmState.value
    if (!s) return
    confirmState.value = null
    s.resolve(value)
  }

  return { toasts, busy, confirmState, toast, ok, err, warn, setBusy, confirm, resolveConfirm }
})

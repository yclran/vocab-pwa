import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { getMeta, setMeta } from '../db/repo.js'

const DEFAULTS = {
  accent: 'us', // 'uk' | 'us'
  autoPlay: true, // 卡片出现时自动读一遍
  speakRate: 1, // 整词语速
  spellRate: 0.7, // 拼读语速
  spellLoops: 2, // 拼读循环次数
  sessionSize: 20, // 每轮学习词量
  filterStopwords: true, // 从文章提词时过滤虚词
  autoEnrich: true, // 导入后自动联网补全
  showEnglishFirst: true, // 卡片正面显示英文
}

export const useSettingsStore = defineStore('settings', () => {
  const s = ref({ ...DEFAULTS })
  const loaded = ref(false)

  async function load() {
    const saved = await getMeta('settings', null)
    if (saved) s.value = { ...DEFAULTS, ...saved }
    loaded.value = true
  }

  watch(
    s,
    (val) => {
      if (loaded.value) setMeta('settings', JSON.parse(JSON.stringify(val)))
    },
    { deep: true }
  )

  function reset() {
    s.value = { ...DEFAULTS }
  }

  return { s, loaded, load, reset, DEFAULTS }
})

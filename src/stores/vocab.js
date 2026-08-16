import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as repo from '../db/repo.js'
import { enrichMany } from '../services/dict/index.js'
import { useUiStore } from './ui.js'
import { useSettingsStore } from './settings.js'

export const useVocabStore = defineStore('vocab', () => {
  const groups = ref([])
  const counts = ref({})
  const totalWords = ref(0)
  const dueCount = ref(0)
  const today = ref({ total: 0, correct: 0, wrong: 0, accuracy: 0, words: 0 })
  const ready = ref(false)
  const enriching = ref(null) // { done, total, current }

  const groupMap = computed(() => Object.fromEntries(groups.value.map((g) => [g.id, g])))

  async function refresh() {
    groups.value = await repo.listGroups()
    counts.value = await repo.countByGroup()
    const all = await repo.listWords({})
    totalWords.value = all.length
    dueCount.value = all.filter((w) => (w.srs?.due ?? 0) <= Date.now()).length
    today.value = await repo.todayStats()
    ready.value = true
  }

  function groupName(id) {
    return groupMap.value[id]?.name || '未分组'
  }

  /* ---------------------------- 导入 ---------------------------- */

  /**
   * 导入词条并按设置决定是否自动联网补全
   * @param {Array<{word:string, zh?:string}>|string[]} entries
   * @param {string[]} groupIds
   */
  async function importEntries(entries, groupIds) {
    const ui = useUiStore()
    const settings = useSettingsStore()

    const res = await repo.addWordsBulk(entries, groupIds)
    await refresh()

    if (res.added === 0 && res.merged > 0) {
      ui.warn(`${res.merged} 个词已存在，已并入所选分组`)
    } else {
      ui.ok(`新增 ${res.added} 个词${res.merged ? `，${res.merged} 个已存在` : ''}`)
    }

    if (settings.s.autoEnrich && res.keys.length) {
      enrich(res.keys)
    }
    return res
  }

  /** 后台补全词典数据，不阻塞界面 */
  async function enrich(keys, { force = false } = {}) {
    const ui = useUiStore()
    if (enriching.value) {
      ui.warn('已有补全任务在进行中')
      return
    }
    if (navigator.onLine === false) {
      ui.warn('当前离线，已缓存的词仍可正常背诵，联网后可再补全')
      return
    }

    enriching.value = { done: 0, total: keys.length, current: '' }
    const stats = await enrichMany(keys, {
      force,
      onProgress: (done, total, current) => {
        enriching.value = { done, total, current }
      },
    })
    enriching.value = null
    await refresh()

    const parts = []
    if (stats.ok) parts.push(`${stats.ok} 个已补全`)
    if (stats.notFound) parts.push(`${stats.notFound} 个词典未收录`)
    if (stats.failed) parts.push(`${stats.failed} 个查询失败`)
    if (stats.noTranslateProvider) {
      parts.push(`${stats.noTranslateProvider} 个缺中文（未配置翻译代理）`)
    }
    if (parts.length) ui.toast(parts.join('，'), stats.failed ? 'warn' : 'success', 4200)
    return stats
  }

  /* ---------------------------- 分组 ---------------------------- */

  async function addGroup(name) {
    const g = await repo.createGroup(name)
    await refresh()
    return g
  }

  async function removeGroup(id) {
    await repo.deleteGroup(id)
    await refresh()
  }

  async function rename(id, name) {
    await repo.renameGroup(id, name)
    await refresh()
  }

  /* ---------------------------- 单词 ---------------------------- */

  async function removeWords(keys) {
    await repo.deleteWords(keys)
    await refresh()
  }

  async function moveTo(keys, groupId, copy = false) {
    await repo.moveWords(keys, groupId, { copy })
    await refresh()
  }

  return {
    groups,
    counts,
    totalWords,
    dueCount,
    today,
    ready,
    enriching,
    groupMap,
    groupName,
    refresh,
    importEntries,
    enrich,
    addGroup,
    removeGroup,
    rename,
    removeWords,
    moveTo,
  }
})

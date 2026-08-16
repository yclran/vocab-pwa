import { getDB, STORE, normalizeKey, BUILTIN_GROUPS } from './schema.js'
import { createInitialSrs } from '../services/srs.js'

/* ============================ 分组 ============================ */

export async function listGroups() {
  const db = await getDB()
  const all = await db.getAll(STORE.GROUPS)
  return all.sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
}

export async function createGroup(name, color = 'slate') {
  const db = await getDB()
  const id = `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const all = await db.getAll(STORE.GROUPS)
  const order = Math.max(0, ...all.map((g) => g.order ?? 0)) + 1
  const group = { id, name: name.trim(), color, builtin: false, order, createdAt: Date.now() }
  await db.put(STORE.GROUPS, group)
  return group
}

export async function renameGroup(id, name) {
  const db = await getDB()
  const g = await db.get(STORE.GROUPS, id)
  if (!g) throw new Error('分组不存在')
  g.name = name.trim()
  await db.put(STORE.GROUPS, g)
  return g
}

/**
 * 删除分组。单词本身不删除，只是从该分组移除；
 * 如果一个词删完后不属于任何分组，则移入「我的生词本」兜底，避免变成孤儿数据。
 */
export async function deleteGroup(id) {
  const db = await getDB()
  const g = await db.get(STORE.GROUPS, id)
  if (!g) return
  if (g.builtin) throw new Error('内置分组不可删除，可以改名')

  const tx = db.transaction([STORE.WORDS, STORE.GROUPS], 'readwrite')
  const wordStore = tx.objectStore(STORE.WORDS)
  const idx = wordStore.index('by_group')
  let cursor = await idx.openCursor(IDBKeyRange.only(id))
  while (cursor) {
    const w = cursor.value
    w.groups = w.groups.filter((x) => x !== id)
    if (w.groups.length === 0) w.groups = ['g_mine']
    w.updatedAt = Date.now()
    await cursor.update(w)
    cursor = await cursor.continue()
  }
  await tx.objectStore(STORE.GROUPS).delete(id)
  await tx.done
}

export async function countByGroup() {
  const db = await getDB()
  const groups = await listGroups()
  const out = {}
  for (const g of groups) {
    out[g.id] = await db.countFromIndex(STORE.WORDS, 'by_group', g.id)
  }
  return out
}

/* ============================ 单词 ============================ */

export function makeWord(raw, { groups = ['g_mine'], zh = null } = {}) {
  const word = String(raw).trim()
  const now = Date.now()
  return {
    key: normalizeKey(word),
    word,
    groups: [...new Set(groups)],
    // 导入时自带的中文（格式 B），优先级高于接口补全
    zhRaw: zh ? String(zh).trim() : null,
    phonetics: { uk: '', us: '' },
    audio: { uk: '', us: '' },
    meanings: [], // [{ pos, zh: [], en: [] }]
    syllables: null,
    examTags: [],
    dictStatus: 'pending', // pending | ok | partial | failed | manual
    dictSources: [],
    note: '',
    createdAt: now,
    updatedAt: now,
    srs: createInitialSrs(),
    stats: { seen: 0, correct: 0, wrong: 0 },
  }
}

export async function getWord(key) {
  const db = await getDB()
  return db.get(STORE.WORDS, normalizeKey(key))
}

export async function putWord(word) {
  const db = await getDB()
  word.updatedAt = Date.now()
  await db.put(STORE.WORDS, word)
  return word
}

export async function listWords({ groupId = null, search = '', limit = 0 } = {}) {
  const db = await getDB()
  let items = groupId
    ? await db.getAllFromIndex(STORE.WORDS, 'by_group', groupId)
    : await db.getAll(STORE.WORDS)

  if (search) {
    const q = search.trim().toLowerCase()
    items = items.filter(
      (w) =>
        w.key.includes(q) ||
        (w.zhRaw && w.zhRaw.includes(q)) ||
        w.meanings.some((m) => m.zh.some((z) => z.includes(q)))
    )
  }

  items.sort((a, b) => b.createdAt - a.createdAt)
  return limit > 0 ? items.slice(0, limit) : items
}

/**
 * 批量新增。已存在的词不会覆盖，只把新分组并进去（这就是「自动去重」）。
 * @returns {{added:number, merged:number, keys:string[]}}
 */
export async function addWordsBulk(entries, groupIds = ['g_mine']) {
  const db = await getDB()
  const tx = db.transaction(STORE.WORDS, 'readwrite')
  const store = tx.objectStore(STORE.WORDS)

  let added = 0
  let merged = 0
  const keys = []
  const seenInBatch = new Set()

  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry : entry.word
    const zh = typeof entry === 'string' ? null : entry.zh
    const key = normalizeKey(raw)
    if (!key || seenInBatch.has(key)) continue
    seenInBatch.add(key)

    const existing = await store.get(key)
    if (existing) {
      const before = existing.groups.length
      existing.groups = [...new Set([...existing.groups, ...groupIds])]
      // 原本没中文、这次导入带了中文 -> 补上
      if (!existing.zhRaw && zh) {
        existing.zhRaw = zh
        if (existing.dictStatus === 'failed') existing.dictStatus = 'partial'
      }
      if (existing.groups.length !== before || zh) {
        existing.updatedAt = Date.now()
        await store.put(existing)
      }
      merged++
    } else {
      await store.put(makeWord(raw, { groups: groupIds, zh }))
      added++
    }
    keys.push(key)
  }

  await tx.done
  return { added, merged, keys }
}

export async function deleteWords(keys) {
  const db = await getDB()
  const tx = db.transaction(STORE.WORDS, 'readwrite')
  for (const k of keys) await tx.store.delete(normalizeKey(k))
  await tx.done
}

/** 批量移动 / 复制到分组 */
export async function moveWords(keys, targetGroupId, { copy = false } = {}) {
  const db = await getDB()
  const tx = db.transaction(STORE.WORDS, 'readwrite')
  for (const k of keys) {
    const w = await tx.store.get(normalizeKey(k))
    if (!w) continue
    w.groups = copy ? [...new Set([...w.groups, targetGroupId])] : [targetGroupId]
    w.updatedAt = Date.now()
    await tx.store.put(w)
  }
  await tx.done
}

/** 加入错题本 */
export async function addToWrongBook(key) {
  const w = await getWord(key)
  if (!w) return
  if (!w.groups.includes('g_wrong')) {
    w.groups = [...w.groups, 'g_wrong']
    await putWord(w)
  }
}

export async function removeFromWrongBook(key) {
  const w = await getWord(key)
  if (!w) return
  w.groups = w.groups.filter((g) => g !== 'g_wrong')
  if (w.groups.length === 0) w.groups = ['g_mine']
  await putWord(w)
}

/* ============================ 学习记录 ============================ */

export async function logRecord(wordKey, mode, correct) {
  const db = await getDB()
  await db.add(STORE.RECORDS, { wordKey, mode, correct, ts: Date.now() })
}

export async function todayStats() {
  const db = await getDB()
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const recs = await db.getAllFromIndex(
    STORE.RECORDS,
    'by_ts',
    IDBKeyRange.lowerBound(start.getTime())
  )
  const correct = recs.filter((r) => r.correct).length
  return {
    total: recs.length,
    correct,
    wrong: recs.length - correct,
    accuracy: recs.length ? Math.round((correct / recs.length) * 100) : 0,
    words: new Set(recs.map((r) => r.wordKey)).size,
  }
}

/** 到期待复习的词 */
export async function dueWords(groupId = null, limit = 200) {
  const db = await getDB()
  const now = Date.now()
  let items = await db.getAllFromIndex(STORE.WORDS, 'by_due', IDBKeyRange.upperBound(now))
  if (groupId) items = items.filter((w) => w.groups.includes(groupId))
  items.sort((a, b) => a.srs.due - b.srs.due)
  return items.slice(0, limit)
}

/* ============================ 设置 ============================ */

export async function getMeta(k, fallback = null) {
  const db = await getDB()
  const row = await db.get(STORE.META, k)
  return row ? row.v : fallback
}

export async function setMeta(k, v) {
  const db = await getDB()
  await db.put(STORE.META, { k, v })
}

/* ============================ 备份 ============================ */

export async function exportJSON() {
  const db = await getDB()
  return {
    format: 'vocab-pwa-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    groups: await db.getAll(STORE.GROUPS),
    words: await db.getAll(STORE.WORDS),
    meta: await db.getAll(STORE.META),
  }
}

/**
 * 导入备份。merge=true 时合并（同词保留本地学习进度），false 时覆盖。
 */
export async function importJSON(payload, { merge = true } = {}) {
  if (payload?.format !== 'vocab-pwa-backup') {
    throw new Error('不是本工具导出的备份文件')
  }
  const db = await getDB()
  const tx = db.transaction([STORE.WORDS, STORE.GROUPS], 'readwrite')
  const gs = tx.objectStore(STORE.GROUPS)
  const ws = tx.objectStore(STORE.WORDS)

  if (!merge) {
    await ws.clear()
    await gs.clear()
    for (const g of BUILTIN_GROUPS) await gs.put({ ...g, createdAt: Date.now() })
  }

  for (const g of payload.groups || []) {
    const exist = await gs.get(g.id)
    if (!exist) await gs.put(g)
  }

  let added = 0
  let updated = 0
  for (const w of payload.words || []) {
    const exist = await ws.get(w.key)
    if (exist && merge) {
      // 合并策略：词典数据取更完整的一方，学习进度保留本地
      exist.groups = [...new Set([...exist.groups, ...w.groups])]
      if (!exist.zhRaw && w.zhRaw) exist.zhRaw = w.zhRaw
      if (exist.meanings.length === 0 && w.meanings?.length) {
        exist.meanings = w.meanings
        exist.phonetics = w.phonetics
        exist.audio = w.audio
        exist.syllables = w.syllables
        exist.dictStatus = w.dictStatus
        exist.dictSources = w.dictSources
      }
      exist.updatedAt = Date.now()
      await ws.put(exist)
      updated++
    } else {
      await ws.put(w)
      added++
    }
  }

  await tx.done
  return { added, updated }
}

export async function exportTXT(groupId = null, { withZh = true } = {}) {
  const words = await listWords({ groupId })
  return words
    .map((w) => {
      if (!withZh) return w.word
      const zh = w.zhRaw || w.meanings.flatMap((m) => m.zh).slice(0, 3).join('；')
      return zh ? `${w.word} ${zh}` : w.word
    })
    .join('\n')
}

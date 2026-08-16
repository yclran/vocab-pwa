import { openDB } from 'idb'

export const DB_NAME = 'vocab-pwa'
export const DB_VERSION = 1

export const STORE = {
  WORDS: 'words',
  GROUPS: 'groups',
  RECORDS: 'records',
  META: 'meta',
}

/**
 * 内置分组。id 固定，便于升级时识别。
 * builtin 的分组不允许删除，但可以改名。
 */
export const BUILTIN_GROUPS = [
  { id: 'g_junior', name: '初中核心单词', color: 'emerald', builtin: true, order: 1 },
  { id: 'g_mine', name: '我的生词本', color: 'blue', builtin: true, order: 2 },
  { id: 'g_wrong', name: '错题复习本', color: 'rose', builtin: true, system: 'wrong', order: 3 },
  { id: 'g_hand', name: '手写收集词', color: 'amber', builtin: true, order: 4 },
]

let dbPromise = null

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion, tx) {
        if (oldVersion < 1) {
          // --- words ---
          // 主键 key = 小写词形，天然实现全局去重
          const words = db.createObjectStore(STORE.WORDS, { keyPath: 'key' })
          words.createIndex('by_group', 'groups', { multiEntry: true })
          words.createIndex('by_due', 'srs.due')
          words.createIndex('by_created', 'createdAt')
          words.createIndex('by_dict_status', 'dictStatus')

          // --- groups ---
          const groups = db.createObjectStore(STORE.GROUPS, { keyPath: 'id' })
          groups.createIndex('by_order', 'order')

          // --- records --- 每一次作答留痕，用于统计
          const records = db.createObjectStore(STORE.RECORDS, {
            keyPath: 'id',
            autoIncrement: true,
          })
          records.createIndex('by_word', 'wordKey')
          records.createIndex('by_ts', 'ts')

          // --- meta --- 设置项
          db.createObjectStore(STORE.META, { keyPath: 'k' })

          // 播种内置分组
          const gStore = tx.objectStore(STORE.GROUPS)
          for (const g of BUILTIN_GROUPS) {
            gStore.put({ ...g, createdAt: Date.now() })
          }
        }
      },
      blocked() {
        console.warn('[db] 有其他标签页占用旧版本数据库，请关闭后重试')
      },
    })
  }
  return dbPromise
}

/** 规范化词形：作为主键使用 */
export function normalizeKey(word) {
  return String(word).trim().toLowerCase().replace(/\s+/g, ' ')
}

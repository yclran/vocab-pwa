/**
 * 艾宾浩斯复习调度
 *
 * 采用经典遗忘曲线间隔（分钟/小时/天），配合三档熟悉度手动评级：
 *   生疏(hard) / 一般(normal) / 熟练(easy)
 *
 * 与 SM-2 的区别：不引入难度因子 ease，家用场景下三档评级已经够用，
 * 参数越少越可预测，孩子也看得懂「这个词几天后再出现」。
 */

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 艾宾浩斯经典间隔：5分钟 → 30分钟 → 12小时 → 1天 → 2天 → 4天 → 7天 → 15天 → 30天 → 60天 */
export const INTERVALS = [
  5 * MIN,
  30 * MIN,
  12 * HOUR,
  1 * DAY,
  2 * DAY,
  4 * DAY,
  7 * DAY,
  15 * DAY,
  30 * DAY,
  60 * DAY,
]

export const MAX_LEVEL = INTERVALS.length - 1

export const GRADE = {
  HARD: 'hard', // 生疏
  NORMAL: 'normal', // 一般
  EASY: 'easy', // 熟练
}

export const GRADE_LABEL = {
  [GRADE.HARD]: '生疏',
  [GRADE.NORMAL]: '一般',
  [GRADE.EASY]: '熟练',
}

export function createInitialSrs() {
  return {
    level: 0,
    due: Date.now(), // 新词立即到期，可以马上学
    reps: 0,
    lapses: 0,
    lastGrade: null,
    lastAt: null,
  }
}

/**
 * 根据评级推进 / 回退等级
 * @param {object} srs 原状态（不修改，返回新对象）
 * @param {'hard'|'normal'|'easy'} grade
 */
export function review(srs, grade) {
  const s = srs && typeof srs.level === 'number' ? { ...srs } : createInitialSrs()
  const now = Date.now()

  if (grade === GRADE.HARD) {
    // 答错/生疏：退两级，并在 5 分钟后重新出现，当天内一定还会再考一次
    s.level = Math.max(0, s.level - 2)
    s.lapses = (s.lapses || 0) + 1
    s.due = now + INTERVALS[0]
  } else if (grade === GRADE.EASY) {
    s.level = Math.min(MAX_LEVEL, s.level + 2)
    s.due = now + INTERVALS[s.level]
  } else {
    s.level = Math.min(MAX_LEVEL, s.level + 1)
    s.due = now + INTERVALS[s.level]
  }

  s.reps = (s.reps || 0) + 1
  s.lastGrade = grade
  s.lastAt = now
  return s
}

/** 答题对错自动映射到评级：对=一般，错=生疏 */
export function reviewByResult(srs, correct) {
  return review(srs, correct ? GRADE.NORMAL : GRADE.HARD)
}

/**
 * 生疏度描述，用于列表上的小标签与详情页。
 * 生疏度 = 根据 SRS 等级换算的「陌生程度」百分比：100% 表示完全陌生，0% 表示非常熟练。
 * 等级同时决定下面的复习「计时」(due = now + INTERVALS[level])，所以生疏度与计时一致。
 * 选「熟练」会让等级 +2，生疏度随之下降（例如 100% → 78%），而不是卡在固定的「生疏」标签上。
 */
export function masteryOf(srs) {
  const lv = srs?.level ?? 0
  if (!srs || srs.reps === 0) return { text: '生疏度 100%', tone: 'slate', degree: 100 }
  const degree = Math.round(((MAX_LEVEL - lv) / MAX_LEVEL) * 100)
  const tone = degree >= 67 ? 'rose' : degree >= 34 ? 'amber' : 'emerald'
  return { text: `生疏度 ${degree}%`, tone, degree }
}

/** 「还有多久复习」的人话描述 */
export function dueText(due) {
  if (!due) return '待学习'
  const diff = due - Date.now()
  if (diff <= 0) return '待复习'
  if (diff < HOUR) return `${Math.ceil(diff / MIN)} 分钟后`
  if (diff < DAY) return `${Math.ceil(diff / HOUR)} 小时后`
  return `${Math.ceil(diff / DAY)} 天后`
}

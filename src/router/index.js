import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('../views/HomeView.vue'),
    meta: { title: '今日', tab: true },
  },
  {
    path: '/library/:groupId?',
    name: 'library',
    component: () => import('../views/LibraryView.vue'),
    meta: { title: '词库', tab: true },
  },
  {
    path: '/import',
    name: 'import',
    component: () => import('../views/ImportView.vue'),
    meta: { title: '导入', tab: true },
  },
  {
    path: '/study',
    name: 'study',
    component: () => import('../views/StudyView.vue'),
    meta: { title: '学习', tab: true },
  },
  {
    path: '/session',
    name: 'session',
    component: () => import('../views/SessionView.vue'),
    meta: { title: '学习中', fullscreen: true },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
    meta: { title: '设置' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, from, saved) {
    return saved || { top: 0 }
  },
})

export default router

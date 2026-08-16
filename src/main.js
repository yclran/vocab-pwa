import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router/index.js'
import './style.css'
import { unlockTTS } from './services/speech.js'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// iOS Safari 要求首次发声必须发生在用户手势里，
// 这里在第一次触摸时静默解锁，之后自动播放才不会被拦。
const unlock = () => {
  unlockTTS()
  window.removeEventListener('touchstart', unlock)
  window.removeEventListener('click', unlock)
}
window.addEventListener('touchstart', unlock, { once: true, passive: true })
window.addEventListener('click', unlock, { once: true })

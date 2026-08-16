<script setup>
import { useUiStore } from '../stores/ui.js'

const ui = useUiStore()
</script>

<template>
  <Teleport to="body">
    <Transition name="page">
      <div
        v-if="ui.confirmState"
        class="fixed inset-0 z-[60] flex items-center justify-center p-4"
      >
        <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" @click="ui.resolveConfirm(false)" />

        <div class="relative w-full max-w-xs rounded-2xl bg-white p-5 shadow-xl">
          <h3 class="text-base font-semibold text-slate-900">{{ ui.confirmState.title }}</h3>
          <p
            v-if="ui.confirmState.message"
            class="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-600"
          >
            {{ ui.confirmState.message }}
          </p>

          <div class="mt-5 flex gap-2">
            <button class="btn-ghost flex-1" @click="ui.resolveConfirm(false)">
              {{ ui.confirmState.cancelText }}
            </button>
            <button
              class="btn-primary flex-1"
              :class="ui.confirmState.danger ? '!bg-rose-600 hover:!bg-rose-700' : ''"
              @click="ui.resolveConfirm(true)"
            >
              {{ ui.confirmState.confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

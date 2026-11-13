<script setup lang="ts">
import { onMounted, ref } from "vue";

const dark = ref(false);

onMounted(() => {
  dark.value = document.documentElement.classList.contains("dark");
});

function toggle() {
  dark.value = !dark.value;
  document.documentElement.classList.toggle("dark", dark.value);
  localStorage.setItem("ribose-theme", dark.value ? "dark" : "light");
}
</script>

<template>
  <button
    type="button"
    class="rounded-sm border border-line px-2 py-1 text-xs text-slate-500 hover:border-brand-400 hover:text-brand-600 dark:hover:text-brand-400"
    :aria-label="dark ? 'Switch to the light theme' : 'Switch to the dark theme'"
    @click="toggle"
  >
    {{ dark ? "Light" : "Dark" }}
  </button>
</template>

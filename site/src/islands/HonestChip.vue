<script setup lang="ts">
/** The honest-state chip: LIVE only when the real healthz says so —
 *  a dark surface renders as dark, never as armed. */
import { onMounted, ref } from "vue";

type State = "checking" | "live" | "dark";
const state = ref<State>("checking");
const instance = ref("");

onMounted(async () => {
  try {
    const res = await fetch("/api/healthz");
    if (res.ok) {
      const body = (await res.json()) as { status?: string; instance?: string };
      if (body.status === "ok") {
        state.value = "live";
        instance.value = body.instance ?? "";
      } else state.value = "dark";
    } else state.value = "dark";
  } catch {
    state.value = "dark";
  }
});
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
    :class="state === 'live' ? 'border-[#2E5B3D] text-brand-700 dark:text-brand-400' : 'border-rule text-slate-500 dark:text-slate-400'"
  >
    <span
      class="h-1.5 w-1.5 rounded-full"
      :class="state === 'live' ? 'bg-brand-500' : 'bg-slate-400 dark:bg-slate-600'"
      aria-hidden="true"
    ></span>
    <template v-if="state === 'live'">The service is operational{{ instance ? ` for ${instance}` : "" }}</template>
    <template v-else-if="state === 'checking'">The service is being checked.</template>
    <template v-else>The service is not connected to its GitHub App yet.</template>
  </span>
</template>

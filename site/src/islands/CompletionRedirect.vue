<script setup lang="ts">
/** Comment-command completion: the signed link validated the handle;
 *  relay to the API — it redirects to the ICLA form (or into the
 *  identity round when the browser session doesn't match). */
import { onMounted } from "vue";

onMounted(() => {
  const t = new URLSearchParams(window.location.search).get("t");
  window.location.href = t ? `/api/icla/complete?t=${encodeURIComponent(t)}` : "/icla";
});
</script>

<template>
  <p class="text-slate-500 dark:text-slate-400">Continuing to the signature line…</p>
</template>

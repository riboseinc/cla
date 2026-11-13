<script setup lang="ts">
/** My agreements: everything YOU are party to — never anyone else's. */
import { onMounted, ref } from "vue";

const me = ref<Record<string, unknown> | null>(null);
const denied = ref(false);
const unarmed = ref(false);

onMounted(async () => {
  const res = await fetch("/api/agreements");
  if (res.status === 404) {
    unarmed.value = true;
    return;
  }
  if (!res.ok) {
    denied.value = true;
    return;
  }
  me.value = (await res.json()) as Record<string, unknown>;
});

const viewText = async (kind: string, version: string) => {
  const res = await fetch(`/api/agreements/text/${kind}/${version}`);
  if (res.ok) {
    const body = (await res.json()) as { text: string; sha256: string };
    alert(`${kind} ${version}\nsha256 ${body.sha256}\n\n${body.text}`);
  }
};
</script>

<template>
  <p v-if="unarmed" class="text-slate-500 dark:text-slate-400">The signing portal is not open yet.</p>
  <p v-else-if="denied" class="text-slate-500 dark:text-slate-400">
    Sign in to see your agreements.
    <a href="/signin/github" class="text-brand-600 hover:underline dark:text-brand-400">Sign in →</a>
  </p>

  <template v-else-if="me">
    <h1 class="font-sans text-2xl font-bold">Agreements and coverage of the signed-in contributor</h1>
    <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">
      Bound identity:
      <span class="font-mono text-xs text-ink dark:text-white">{{ (me.bound as any)?.github_login }}</span>
      · everything here is recorded in your name only.
    </p>

    <section class="mt-8">
      <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Individual Contributor License Agreements</h2>
      <div v-if="(me.iclaSignatures as any[]).length === 0" class="mt-3 text-sm text-slate-500 dark:text-slate-400">
        No Individual Contributor License Agreement is recorded for this handle. The signing page records one. Use /icla.
      </div>
      <ul v-else class="mt-3 space-y-2">
        <li v-for="s in me.iclaSignatures as any[]" :key="s.edition.version + s.edition.textSha256" class="flex items-center justify-between rounded-sm border border-rule bg-white dark:bg-ink-2 px-4 py-3 text-sm">
          <span>Individual CLA <span class="font-mono">v{{ s.edition.version }}</span></span>
          <span class="flex items-center gap-3">
            <span :class="s.current ? 'text-brand-700 dark:text-brand-400' : 'text-amber-600 dark:text-amber-400'">{{ s.current ? "current" : "stale — re-sign" }}</span>
            <button class="font-mono text-xs text-brand-600 hover:underline dark:text-brand-400" @click="viewText('icla', s.edition.version)">view text</button>
          </span>
        </li>
      </ul>
    </section>

    <section class="mt-8">
      <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Organization CLA coverage</h2>
      <div v-if="(me.oclaCoverages as any[]).length === 0" class="mt-3 text-sm text-slate-500 dark:text-slate-400">
        No Organization CLA coverage is recorded for this handle. Coverage is requested on the organizations page, or the Point of Contact of the employer adds the handle directly.
      </div>
      <ul v-else class="mt-3 space-y-2">
        <li v-for="c in me.oclaCoverages as any[]" :key="c.org" class="flex items-center justify-between rounded-sm border border-rule bg-white dark:bg-ink-2 px-4 py-3 text-sm">
          <span>{{ c.org }} <span class="font-mono">OCLA v{{ c.edition.version }}</span> — as Schedule A records: {{ c.row?.github_login }}</span>
          <span :class="c.current ? 'text-brand-700 dark:text-brand-400' : 'text-amber-600 dark:text-amber-400'">{{ c.current ? "active" : "stale" }}</span>
        </li>
      </ul>
    </section>

    <section v-if="(me.attributions as any[]).length" class="mt-8">
      <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Elections recorded for pull requests</h2>
      <ul class="mt-3 space-y-2">
        <li v-for="a in me.attributions as any[]" :key="a.repo + a.pr" class="rounded-sm border border-rule bg-white dark:bg-ink-2 px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
          {{ a.repo }}#{{ a.pr }} → {{ a.agreement?.kind }}
        </li>
      </ul>
    </section>
  </template>
</template>

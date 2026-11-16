<script setup lang="ts">
/** My agreements: everything YOU are party to — never anyone else's. */
import { onMounted, onUnmounted, ref } from "vue";

type Edition = { version: string; textSha256: string };
type IclaSig = { edition: Edition; current: boolean; email: string | null };
type OclaCov = {
  org: string;
  edition: Edition;
  current: boolean;
  row: { githubLogin: string; email?: string | null } | undefined;
};
type ViewDoc = { title: string; sha256: string; text: string };

const me = ref<Record<string, unknown> | null>(null);
const denied = ref(false);
const unarmed = ref(false);
const loading = ref(true);
const viewing = ref<ViewDoc | null>(null);

const iclas = () => (me.value?.iclaSignatures as IclaSig[]) ?? [];
const oclas = () => (me.value?.oclaCoverages as OclaCov[]) ?? [];
const attributions = () => (me.value?.attributions as Array<{ repo: string; pr: number; agreement: { kind: string } }>) ?? [];
const bound = () => (me.value?.bound as { github_login: string }) ?? { github_login: "" };

const onEscape = (e: KeyboardEvent) => {
  if (e.key === "Escape") viewing.value = null;
};

onMounted(async () => {
  const res = await fetch("/api/agreements");
  if (res.status === 404) {
    unarmed.value = true;
  } else if (!res.ok) {
    denied.value = true;
  } else {
    me.value = (await res.json()) as Record<string, unknown>;
  }
  loading.value = false;
  window.addEventListener("keydown", onEscape);
});
onUnmounted(() => window.removeEventListener("keydown", onEscape));

const viewText = async (title: string, kind: string, version: string) => {
  const res = await fetch(`/api/agreements/text/${kind}/${version}`);
  if (res.ok) {
    const body = (await res.json()) as { text: string; sha256: string };
    viewing.value = { title: `${title} — v${version}`, sha256: body.sha256, text: body.text };
  }
};

const pillClass = (ok: boolean) =>
  ok
    ? "rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
    : "rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
const hashOf = (e: Edition) => e.textSha256.slice(0, 16) + "…";
</script>

<template>
  <p v-if="loading" class="text-sm text-slate-500 dark:text-slate-400">Your agreements are loading.</p>

  <p v-else-if="unarmed" class="text-sm text-slate-500 dark:text-slate-400">The signing portal is not open yet.</p>

  <div v-else-if="denied" class="rounded-sm border border-rule bg-white p-6 dark:bg-ink-2">
    <p class="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
      This page records the agreements of one contributor, and the record
      reads only through a signed-in session.
    </p>
    <a href="/signin/github" class="mt-4 inline-flex items-center rounded-sm bg-ink px-4 py-2.5 text-sm font-medium text-white no-underline hover:bg-slate-700 dark:bg-white dark:text-ink dark:hover:bg-slate-200">
      Sign in with GitHub
    </a>
  </div>

  <template v-else-if="me">
    <!-- the identity card -->
    <div class="flex items-center gap-4 rounded-sm border border-rule bg-white p-5 dark:bg-ink-2">
      <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-500 text-lg font-semibold text-white" aria-hidden="true">
        {{ (bound().github_login || "?").slice(0, 1).toUpperCase() }}
      </span>
      <div class="min-w-0">
        <p class="font-mono text-sm font-semibold text-ink dark:text-white">@{{ bound().github_login }}</p>
        <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Everything below is recorded in your name only — bound to this
          handle and your Ribose ID.
        </p>
      </div>
      <a href="/logout" class="ml-auto shrink-0 text-xs text-slate-500 no-underline hover:text-ink dark:text-slate-400 dark:hover:text-white">Sign out</a>
    </div>

    <!-- Individual CLA -->
    <section class="mt-8">
      <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Individual Contributor License Agreement</h2>
      <div v-if="iclas().length === 0" class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-rule bg-white p-5 dark:bg-ink-2">
        <p class="max-w-prose text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          No Individual Contributor License Agreement is recorded for this
          handle. Contributions to Ribose organizations stay blocked until
          one is on record.
        </p>
        <a href="/icla" class="shrink-0 rounded-sm bg-brand-500 px-4 py-2 text-sm font-medium text-white no-underline hover:bg-brand-400">Sign the ICLA</a>
      </div>
      <ul v-else class="mt-3 space-y-3">
        <li v-for="s in iclas()" :key="s.edition.version + s.edition.textSha256" class="rounded-sm border border-rule bg-white p-5 dark:bg-ink-2">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-sm font-semibold text-ink dark:text-white">Individual Contributor License Agreement</p>
              <p class="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                edition v{{ s.edition.version }} · sha256 {{ hashOf(s.edition) }}
              </p>
            </div>
            <span :class="pillClass(s.current)">{{ s.current ? "current" : "stale — the current edition is newer" }}</span>
          </div>
          <div class="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3">
            <p class="text-xs text-slate-500 dark:text-slate-400">
              Recorded for <span class="font-mono">@{{ bound().github_login }}</span><template v-if="s.email"> · {{ s.email }}</template>
            </p>
            <div class="flex items-center gap-3">
              <button class="text-xs text-brand-600 underline underline-offset-2 dark:text-brand-400" @click="viewText('Individual Contributor License Agreement', 'icla', s.edition.version)">View the exact text</button>
              <a v-if="!s.current" href="/icla" class="rounded-sm bg-brand-500 px-3 py-1.5 text-xs font-medium text-white no-underline hover:bg-brand-400">Re-sign</a>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <!-- Organization CLA coverage -->
    <section class="mt-8">
      <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Organization CLA coverage</h2>
      <div v-if="oclas().length === 0" class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-rule bg-white p-5 dark:bg-ink-2">
        <p class="max-w-prose text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          No Organization CLA covers this handle. Coverage arrives when your
          employer's Point of Contact adds you, or by your own request on
          the organizations page.
        </p>
        <a href="/organizations" class="shrink-0 rounded-sm border border-rule px-4 py-2 text-sm font-medium text-ink no-underline hover:border-brand-400 dark:border-slate-700 dark:text-white">Request coverage</a>
      </div>
      <ul v-else class="mt-3 space-y-3">
        <li v-for="c in oclas()" :key="c.org + c.edition.version" class="rounded-sm border border-rule bg-white p-5 dark:bg-ink-2">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-sm font-semibold text-ink dark:text-white">{{ c.org }} — Organization Contributor License Agreement</p>
              <p class="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                edition v{{ c.edition.version }} · Schedule A row for <span class="font-mono">@{{ c.row?.githubLogin }}</span>
              </p>
            </div>
            <span :class="pillClass(c.current)">{{ c.current ? "active" : "stale" }}</span>
          </div>
          <div class="mt-3 border-t border-rule pt-3 text-right">
            <button class="text-xs text-brand-600 underline underline-offset-2 dark:text-brand-400" @click="viewText(`${c.org} OCLA`, 'ocla', c.edition.version)">View the exact text</button>
          </div>
        </li>
      </ul>
    </section>

    <!-- Attributions -->
    <section v-if="attributions().length" class="mt-8">
      <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Elections recorded for pull requests</h2>
      <ul class="mt-3 space-y-2">
        <li v-for="a in attributions()" :key="a.repo + a.pr" class="rounded-sm border border-rule bg-white px-4 py-3 font-mono text-xs text-slate-600 dark:bg-ink-2 dark:text-slate-400">
          {{ a.repo }}#{{ a.pr }} — contributed under the {{ a.agreement?.kind === "icla" ? "Individual CLA" : "organization CLA" }}
        </li>
      </ul>
    </section>

    <!-- the exact-text viewer -->
    <div v-if="viewing" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="viewing = null">
      <div role="dialog" aria-modal="true" :aria-label="viewing.title" class="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-sm bg-paper text-paper-ink shadow-2xl">
        <div class="flex items-center justify-between gap-4 border-b border-rule px-6 py-4">
          <p class="font-serif text-lg font-semibold">{{ viewing.title }}</p>
          <button class="text-paper-ink/60 hover:text-paper-ink" aria-label="Close" @click="viewing = null">✕</button>
        </div>
        <p class="border-b border-rule bg-white/60 px-6 py-2 font-mono text-xs text-paper-ink/70">sha256 {{ viewing.sha256 }}</p>
        <div class="overflow-y-auto px-6 py-5">
          <p v-for="(para, i) in viewing.text.split('\n').filter((l) => l.trim())" :key="i" class="mb-4 whitespace-pre-line font-serif text-[14px] leading-relaxed last:mb-0">{{ para }}</p>
        </div>
      </div>
    </div>
  </template>
</template>

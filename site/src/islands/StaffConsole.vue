<script setup lang="ts">
/** The staff console: token stays in THIS tab's memory only; every
 *  action audits server-side. Remedies + legacy import, nothing gates
 *  on it. */
import { ref } from "vue";

const token = ref(sessionStorage.getItem("ops-token") ?? "");
const unlocked = ref(Boolean(token.value));
const error = ref("");
const notice = ref("");
const auditRows = ref<Array<Record<string, unknown>>>([]);

const api = (path: string, body: Record<string, unknown>) =>
  fetch(`/api/admin/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.value}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function lock() {
  sessionStorage.removeItem("ops-token");
  token.value = "";
  unlocked.value = false;
}

async function call(path: string, body: Record<string, unknown>, label: string) {
  error.value = "";
  notice.value = "";
  const res = await api(path, body);
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) error.value = `${label}: ${json["error"] ?? res.status}`;
  else notice.value = `${label} ✓ (${JSON.stringify(json).slice(0, 160)})`;
  return json;
}

async function loadAudit() {
  const res = await fetch("/api/admin/audit", { headers: { authorization: `Bearer ${token.value}` } });
  if (res.ok) auditRows.value = ((await res.json()) as { entries: Array<Record<string, unknown>> }).entries;
}
</script>

<template>
  <h1 class="font-sans text-2xl font-bold">Staff console</h1>
  <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">Remedies + legacy import only. Every action lands in the audit trail.</p>

  <div v-if="!unlocked" class="mt-8 max-w-md">
    <label class="text-sm text-slate-500 dark:text-slate-400">Ops token (kept in this tab's memory, never stored)</label>
    <input
      v-model="token"
      type="password"
      class="mt-2 w-full rounded-sm border border-rule bg-ground-2 px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none"
      @keydown.enter="unlocked = Boolean(token)"
    />
    <button class="mt-3 rounded-sm bg-brand-500 px-4 py-2 text-ink text-sm font-medium text-white hover:opacity-90" @click="unlocked = Boolean(token)">Open console</button>
  </div>

  <template v-else>
    <p class="mt-4 text-xs text-slate-500 dark:text-slate-400">
      token in memory ·
      <button class="underline" @click="lock">lock</button> ·
      <button class="underline" @click="loadAudit">load audit</button>
    </p>

    <p v-if="error" class="mt-4 rounded-sm border border-seal/50 bg-seal/10 px-4 py-3 text-sm text-[#E8A090]" role="alert">{{ error }}</p>
    <p v-if="notice" class="mt-4 rounded-sm border border-[#2E5B3D] bg-[#12241A] px-4 py-3 font-mono text-xs text-[#7FC497]">{{ notice }}</p>

    <section class="mt-8 rounded-sm border border-rule bg-ground-2 p-6">
      <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">void an agreement</h2>
      <form class="mt-4 flex flex-wrap gap-2" @submit.prevent="call('void', { target_id: ($refs.voidTarget as HTMLInputElement).value, reason: ($refs.voidReason as HTMLTextAreaElement).value }, 'void').then(loadAudit)">
        <input ref="voidTarget" placeholder="record id" class="w-64 rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none" required />
        <textarea ref="voidReason" placeholder="reason" class="min-h-[2.5rem] w-72 rounded-sm border border-rule bg-ink px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" required></textarea>
        <button class="rounded-sm bg-[#3A2620] px-4 py-2 text-sm font-medium text-[#E8A090] hover:opacity-90">Void</button>
      </form>
    </section>

    <section class="mt-6 rounded-sm border border-rule bg-ground-2 p-6">
      <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">backfill import (evidence-verified)</h2>
      <form
        class="mt-4 space-y-3"
        @submit.prevent="call('backfill-ocla', { evidence: { path: ($refs.evPath as HTMLInputElement).value, sha256: ($refs.evSha as HTMLInputElement).value }, org_slug: ($refs.orgSlug as HTMLInputElement).value, covered: JSON.parse(($refs.covered as HTMLTextAreaElement).value || '[]'), poc: { email: ($refs.pocEmail as HTMLInputElement).value }, signed_at: ($refs.signedAt as HTMLInputElement).value }, 'backfill-ocla')"
      >
        <div class="flex flex-wrap gap-2">
          <input ref="evPath" placeholder="evidence path (mtg/2026-03-01-ccla.pdf)" class="w-80 rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none" required />
          <input ref="evSha" placeholder="evidence sha256" class="w-96 rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none" required />
        </div>
        <div class="flex flex-wrap gap-2">
          <input ref="orgSlug" placeholder="org slug" class="w-48 rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none" required />
          <input ref="pocEmail" placeholder="poc email (for the enrollment link)" class="w-72 rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none" />
          <input ref="signedAt" placeholder="signed_at (2026-03-01)" class="w-44 rounded-sm border border-rule bg-ink px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
        </div>
        <textarea
          ref="covered"
          rows="4"
          placeholder='covered: [{"githubLogin": "tj-91", "name": "Johannes Roth"}, …]'
          class="w-full rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none"
          required
        ></textarea>
        <button class="rounded-sm bg-brand-500 px-4 py-2 text-ink text-sm font-medium text-white hover:opacity-90">Import (hash must match or it refuses)</button>
      </form>
    </section>

    <section class="mt-6 rounded-sm border border-rule bg-ground-2 p-6">
      <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">audit trail</h2>
      <ul class="mt-3 space-y-1 font-mono text-xs text-slate-500 dark:text-slate-400">
        <li v-for="r in auditRows" :key="r.id as string">{{ r.at }} · {{ r.action }} · {{ r.target }} · {{ r.detail }}</li>
        <li v-if="auditRows.length === 0">no rows loaded (or none yet)</li>
      </ul>
    </section>
  </template>
</template>

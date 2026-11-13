<script setup lang="ts">
/** The PoC console: your orgs only. Effective Schedule A, pending
 *  join requests, mods; approve/reject/add/remove land as mods. */
import { onMounted, ref } from "vue";

const orgs = ref<Array<{ slug: string }> | null>(null);
const slug = ref("");
const data = ref<Record<string, unknown> | null>(null);
const error = ref("");
const csrf = document.cookie.match(/cla_csrf=([^;]+)/)?.[1] ?? "";

const authed = () => ({ headers: { cookie: document.cookie }, credentials: "same-origin" } as const);
const json = (b: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(b) } as RequestInit);

onMounted(async () => {
  slug.value = window.location.pathname.split("/").pop() ?? "";
  const res = await fetch("/api/admin-orgs", { credentials: "same-origin" });
  if (res.status === 401) {
    error.value = "Sign in (GitHub, top right), then open the console.";
    return;
  }
  orgs.value = ((await res.json()) as { organizations: Array<{ slug: string }> }).organizations;
  if (slug.value && slug.value !== "index") await load();
  else if (orgs.value?.length === 1) {
    slug.value = orgs.value[0]!.slug;
    await load();
  }
});

async function load() {
  const res = await fetch(`/api/admin-orgs/${slug.value}`, { credentials: "same-origin" });
  if (!res.ok) {
    error.value = String(((await res.json()) as Record<string, unknown>)["error"] ?? res.status);
    data.value = null;
    return;
  }
  data.value = (await res.json()) as Record<string, unknown>;
}

async function decide(id: string, decision: "approve" | "reject") {
  const res = await fetch(`/api/admin-orgs/${slug.value}/decide`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, request_id: id, decision }),
  });
  if (!res.ok) error.value = String(((await res.json()) as Record<string, unknown>)["error"]);
  await load();
}

async function add(form: Event) {
  const f = new FormData(form as HTMLFormElement);
  const res = await fetch(`/api/admin-orgs/${slug.value}/add`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, login: String(f.get("login") ?? ""), name: String(f.get("name") ?? ""), email: String(f.get("email") ?? ""), title: String(f.get("title") ?? "") }),
  });
  if (!res.ok) error.value = String(((await res.json()) as Record<string, unknown>)["error"]);
  await load();
}

async function remove(login: string) {
  const res = await fetch(`/api/admin-orgs/${slug.value}/remove`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, login }),
  });
  if (!res.ok) error.value = String(((await res.json()) as Record<string, unknown>)["error"]);
  await load();
}
</script>

<template>
  <h1 class="font-sans text-2xl font-bold">Point-of-Contact console</h1>

  <p v-if="error" class="mt-4 rounded-sm border border-seal/50 bg-seal/10 px-4 py-3 text-sm text-[#E8A090]" role="alert">{{ error }}</p>

  <template v-if="orgs === null && !error"><p class="mt-4 text-slate-500 dark:text-slate-400">Loading…</p></template>

  <template v-else-if="orgs && !slug">
    <p class="mt-4 text-sm text-slate-500 dark:text-slate-400">Organizations where you hold the admin role:</p>
    <ul class="mt-4 space-y-2">
      <li v-for="o in orgs" :key="o.slug">
        <a :href="`/admin-orgs/${o.slug}`" class="block rounded-sm border border-rule bg-ground-2 px-4 py-3 font-mono text-sm hover:border-brand-400">{{ o.slug }} →</a>
      </li>
    </ul>
    <p v-if="orgs.length === 0" class="text-sm text-slate-500 dark:text-slate-400">No admin grants — enroll via the link from your organization's signatory.</p>
  </template>

  <template v-else-if="data">
    <p class="mt-2 font-mono text-sm text-slate-500 dark:text-slate-400">{{ slug }}</p>

    <section class="mt-8">
      <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">pending join requests</h2>
      <ul class="mt-3 space-y-2">
        <li v-for="r in (data.pendingJoinRequests as any[])" :key="r.id" class="flex items-center justify-between rounded-sm border border-rule bg-ground-2 px-4 py-3 text-sm">
          <span><span class="font-mono">{{ r.login }}</span> — requested {{ String(r.requested_at).slice(0, 10) }}</span>
          <span class="flex gap-2">
            <button class="rounded-sm bg-[#1E3A2A] px-3 py-1.5 text-[#7FC497] hover:opacity-90" @click="decide(r.id, 'approve')">Approve</button>
            <button class="rounded-sm bg-[#3A2620] px-3 py-1.5 text-[#E8A090] hover:opacity-90" @click="decide(r.id, 'reject')">Reject</button>
          </span>
        </li>
        <li v-if="(data.pendingJoinRequests as any[]).length === 0" class="text-sm text-slate-500 dark:text-slate-400">Nothing pending.</li>
      </ul>
    </section>

    <section class="mt-8">
      <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">effective schedule A</h2>
      <ul class="mt-3 space-y-2">
        <li v-for="row in (data.effectiveScheduleA as any[])" :key="row.githubLogin" class="flex items-center justify-between rounded-sm border border-rule bg-ground-2 px-4 py-3 text-sm">
          <span><span class="font-mono">{{ row.githubLogin }}</span> <span class="text-slate-500 dark:text-slate-400">{{ row.name || "" }}</span></span>
          <button class="text-xs text-[#E8A090] hover:underline" @click="remove(row.githubLogin)">remove</button>
        </li>
      </ul>
      <form class="mt-4 flex flex-wrap items-end gap-2" @submit.prevent="add">
        <input name="login" placeholder="github login" class="w-40 rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-seal focus:outline-none" required />
        <input name="name" placeholder="name" class="w-44 rounded-sm border border-rule bg-ink px-3 py-2 text-sm focus:border-seal focus:outline-none" />
        <input name="email" placeholder="email" class="w-48 rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-seal focus:outline-none" />
        <input name="title" placeholder="title" class="w-40 rounded-sm border border-rule bg-ink px-3 py-2 text-sm focus:border-seal focus:outline-none" />
        <button class="rounded-sm bg-brand-500 px-4 py-2 text-ink text-sm font-medium text-white hover:opacity-90">Add (validated live)</button>
      </form>
    </section>

    <section class="mt-8">
      <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">modification history</h2>
      <ul class="mt-3 space-y-1 font-mono text-xs text-slate-500 dark:text-slate-400">
        <li v-for="m in (data.mods as any[])">{{ String(m.recordedAt).slice(0, 10) }} — {{ m.add?.length ?? 0 }} added / {{ m.removeLogins?.length ?? 0 }} removed</li>
        <li v-if="(data.mods as any[]).length === 0">no modifications yet</li>
      </ul>
    </section>
  </template>
</template>

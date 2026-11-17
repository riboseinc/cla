<script setup lang="ts">
/** The Ribose internal roster (issue #62): a management view of the
 *  estate's own people — linked? signed? which edition? outstanding?
 *  A management grouping only; it never grants coverage. */
import { onMounted, ref } from "vue";

type Member = { login: string; role: string; name: string; linked: boolean; signed: boolean; state: string; edition: string | null };
const denied = ref(false);
const loading = ref(true);
const managers = ref<string[]>([]);
const members = ref<Member[]>([]);
const load = async () => {
  const res = await fetch("/api/roster");
  if (res.status === 401) {
    window.location.href = "/signin/github";
    return;
  }
  if (!res.ok) {
    denied.value = true;
    loading.value = false;
    return;
  }
  const body = (await res.json()) as { managers: string[]; members: Member[] };
  managers.value = body.managers;
  members.value = body.members;
  loading.value = false;
};
onMounted(load);


</script>

<template>
  <p v-if="loading" class="text-sm text-slate-500 dark:text-slate-400">The roster is loading.</p>

  <div v-else-if="denied" class="rounded-sm border border-rule bg-white p-6 dark:bg-ink-2">
    <p class="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
      The roster is a management surface, and it reads only for the
      estate's roster managers through a signed-in session.
    </p>
    <a href="/signin/github" class="mt-4 inline-flex items-center rounded-sm bg-ink px-4 py-2.5 text-sm font-medium text-white no-underline hover:bg-slate-700 dark:bg-white dark:text-ink">Sign in with GitHub</a>
  </div>

  <template v-else>
    <h1 class="font-serif text-2xl font-semibold">The Ribose roster</h1>
    <p class="mt-2 max-w-prose text-sm leading-relaxed text-slate-500 dark:text-slate-400">
      The live state of every member of the internal roster: whether the
      GitHub handle is linked to a Ribose ID account, whether a current
      Individual CLA is on record, and which edition it carries. The
      roster manages and displays; it never grants coverage.
    </p>

    <div class="mt-6 overflow-hidden rounded-sm border border-rule bg-white dark:bg-ink-2">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-rule text-left font-mono text-xs uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
            <th class="px-4 py-3">Member</th>
            <th class="px-4 py-3">Role</th>
            <th class="px-4 py-3">Linked</th>
            <th class="px-4 py-3">ICLA</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in members" :key="m.login" class="border-b border-rule last:border-0">
            <td class="px-4 py-3 font-mono text-ink dark:text-white">@{{ m.login }}<span v-if="m.name" class="ml-2 font-sans text-slate-500 dark:text-slate-400">{{ m.name }}</span></td>
            <td class="px-4 py-3 text-slate-600 dark:text-slate-400">{{ m.role }}</td>
            <td class="px-4 py-3">
              <span :class="m.linked ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-400'">{{ m.linked ? "linked" : "not linked" }}</span>
            </td>
            <td class="px-4 py-3">
              <span v-if="m.state === 'signed'" class="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">signed v{{ m.edition }}</span>
              <span v-else-if="m.state === 'stale'" class="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">stale — re-sign needed</span>
              <span v-else class="rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-900/40 dark:text-rose-300">outstanding</span>
            </td>
            <td class="px-4 py-3 text-right text-xs text-slate-400">
              policy
            </td>
          </tr>
          <tr v-if="members.length === 0">
            <td colspan="4" class="px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">The roster carries no members yet; its membership lives in the instance config.</td>
          </tr>
        </tbody>
      </table>
    </div>


  </template>
</template>

<script setup lang="ts">
/** Coverage under an Organization CLA. The Point of Contact of the
 *  organization manages the Schedule A and adds handles directly; this
 *  page requests an addition for a specific organization by its slug.
 *  Organizations are not enumerable: the service reveals nothing about
 *  an organization to a caller who does not already know its slug. */
import { onMounted, ref } from "vue";

type Phase = "checking" | "signin" | "ask" | "requested" | "error";
const phase = ref<Phase>("checking");
const slug = ref("");
const error = ref("");
const requested = ref("");

onMounted(async () => {
  const res = await fetch("/api/agreements");
  phase.value = res.status === 401 ? "signin" : "ask";
});

async function request() {
  error.value = "";
  if (!slug.value.trim()) return;
  const res = await fetch(`/api/organizations/${encodeURIComponent(slug.value.trim().toLowerCase())}/join`, { method: "POST" });
  const json = (await res.json()) as Record<string, unknown>;
  if (res.ok && json["requested"]) {
    requested.value = String(json["org"]);
    phase.value = "requested";
  } else if (res.status === 409) {
    error.value = String(json["error"]);
  } else {
    error.value = String(json["error"] ?? `request failed (${res.status})`);
    if (res.status === 404) phase.value = "error";
  }
}
</script>

<template>
  <p v-if="phase === 'checking'" class="text-slate-500 dark:text-slate-400">The session is being checked.</p>

  <template v-else-if="phase === 'signin'">
    <p class="font-mono text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Organization CLA · coverage</p>
    <h1 class="mt-3 font-sans text-2xl font-bold">Coverage begins with a verified GitHub handle</h1>
    <p class="mt-4 max-w-2xl text-base leading-relaxed">
      The service records a coverage request only after the contributor has
      proven ownership of the GitHub handle for which coverage is requested.
      The proof happens through GitHub itself.
    </p>
    <a href="/signin/github" class="mt-6 inline-block rounded-sm bg-brand-500 px-5 py-3 font-semibold text-ink transition-colors hover:bg-brand-400">
      Sign in with GitHub
    </a>
  </template>

  <template v-else-if="phase === 'ask'">
    <p class="font-mono text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Organization CLA · coverage</p>
    <h1 class="mt-3 font-sans text-2xl font-bold">Requesting coverage under an Organization CLA</h1>

    <p class="mt-4 max-w-2xl text-base leading-relaxed">
      An employee whose organization has executed an Organization CLA is
      covered when their GitHub handle appears in the Schedule A of that
      agreement. The Point of Contact of the organization manages the
      Schedule A, and the fastest route to coverage is a message to that
      person, who adds the handle directly.
    </p>
    <p class="mt-4 max-w-2xl text-base leading-relaxed">
      A contributor who knows the slug of the organization can also request
      the addition on this page. The request is placed before the Point of
      Contact, who approves it before coverage begins. The service does not
      publish the organizations that hold agreements, and it answers a
      request only to a caller who states an existing slug.
    </p>

    <form class="mt-6 flex max-w-md gap-2" @submit.prevent="request">
      <label class="sr-only" for="org-slug">Organization slug</label>
      <input
        id="org-slug"
        v-model="slug"
        placeholder="organization-slug"
        autocomplete="off"
        class="w-full rounded-sm border border-line bg-paper px-3 py-2 font-mono text-sm text-ink focus:border-brand-500 focus:outline-none dark:border-ink-2 dark:bg-ink dark:text-slate-100"
      />
      <button class="whitespace-nowrap rounded-sm bg-brand-500 px-4 py-2 font-semibold text-ink hover:bg-brand-400">Request coverage</button>
    </form>
    <p v-if="error" class="mt-3 max-w-md text-sm text-accent-600 dark:text-accent-400" role="alert">{{ error }}</p>
    <p class="mt-6 max-w-2xl text-sm leading-relaxed text-slate-500 dark:text-slate-400">
      An organization that has not executed an Organization CLA is invited
      to do so on the execution page, which takes minutes; the employees of
      the organization are covered from the moment the agreement is
      recorded and the Schedule A carries their handles.
    </p>
    <a href="/sign-ocla" class="text-sm text-brand-600 dark:text-brand-400 hover:underline">Open the execution page</a>
  </template>

  <template v-else-if="phase === 'requested'">
    <div class="mx-auto max-w-xl rounded-sm border border-line bg-paper p-8 dark:border-ink-2 dark:bg-ink-2">
      <h1 class="font-sans text-2xl font-bold">The request has been placed.</h1>
      <p class="mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
        The request for the handle of the signed-in contributor is before the
        Point of Contact of {{ requested }}. The Point of Contact receives a
        notification by email, and the service sends a second message when
        the request is decided. The coverage applies to pull requests at the
        next evaluation after the approval.
      </p>
      <a href="/agreements" class="mt-6 inline-block text-sm text-brand-600 dark:text-brand-400 hover:underline">Follow the request on the agreements page</a>
    </div>
  </template>

  <template v-else>
    <p class="max-w-2xl text-sm leading-relaxed text-slate-500 dark:text-slate-400">
      {{ error }} The slug can be confirmed with the Point of Contact of the
      organization, and the request can be repeated at any time.
    </p>
  </template>
</template>

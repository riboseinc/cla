<script setup lang="ts">
/** Join by exact slug — orgs are NOT enumerable (owner decision
 *  2026-11-13): your PoC shares the slug, you request coverage. */
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
  <p v-if="phase === 'checking'" class="text-mist">Checking your session…</p>

  <template v-else-if="phase === 'signin'">
    <h1 class="font-serif text-2xl font-semibold">Join your organization's CLA</h1>
    <p class="mt-3 max-w-xl text-sm leading-relaxed text-mist">Sign in with your GitHub account first — your handle is what gets covered.</p>
    <a href="/signin/github" class="mt-6 inline-block rounded-sm bg-[#E8EAED] px-4 py-3 font-medium text-ink hover:bg-white">Sign in</a>
  </template>

  <template v-else-if="phase === 'ask'">
    <h1 class="font-serif text-2xl font-semibold">Request Schedule-A coverage</h1>
    <p class="mt-3 max-w-xl text-sm leading-relaxed text-mist">
      Enter your organization's slug — your Point of Contact (or your
      onboarding doc) has it. Organizations are not listed by design:
      coverage is requested by exact name, then approved by your PoC.
    </p>
    <form class="mt-6 flex max-w-md gap-2" @submit.prevent="request">
      <input
        v-model="slug"
        placeholder="e.g. mtg-ag"
        class="w-full rounded-sm border border-rule bg-ground-2 px-3 py-2 font-mono text-sm focus:border-seal focus:outline-none"
      />
      <button class="whitespace-nowrap rounded-sm bg-seal px-4 py-2 font-medium text-white hover:opacity-90">Request coverage</button>
    </form>
    <p v-if="error" class="mt-3 max-w-md text-sm text-caution" role="alert">{{ error }}</p>
    <p class="mt-6 text-xs leading-relaxed text-mist">
      No Organization CLA at your employer? Point them at
      <a class="text-seal hover:underline" href="/sign-ocla">/sign-ocla</a> — it takes minutes,
      and you'll be covered the moment they're recorded.
    </p>
  </template>

  <template v-else-if="phase === 'requested'">
    <div class="mx-auto max-w-md rounded-sm border border-rule bg-ground-2 p-8 text-center">
      <span class="mx-auto block h-3 w-3 rounded-[2px] bg-caution" aria-hidden="true"></span>
      <h1 class="mt-4 font-serif text-2xl font-semibold">Requested.</h1>
      <p class="mt-3 text-sm leading-relaxed text-mist">
        Your coverage request for <strong class="text-[#E8EAED]">{{ requested }}</strong> is with the
        organization's Point of Contact. You'll get an email when it's
        decided, and your next pull request will pick coverage up the
        moment it lands.
      </p>
      <a href="/agreements" class="mt-6 inline-block text-sm text-seal hover:underline">Track it in my agreements →</a>
    </div>
  </template>

  <template v-else>
    <p class="text-mist">{{ error }} — check the slug with your Point of Contact.</p>
  </template>
</template>

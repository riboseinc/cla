<script setup lang="ts">
/** The must-specify election: the bot's signed link lands here; only
 *  the committer may elect; the choice records and re-checks. */
import { onMounted, ref } from "vue";

const token = ref("");
const pick = ref("");
const options = ref<Array<{ label: string; kind: string; pick: string }>>([]);
const state = ref<"checking" | "signin" | "ready" | "recorded" | "error">("checking");
const message = ref("");

onMounted(async () => {
  const params = new URLSearchParams(window.location.search);
  token.value = params.get("t") ?? "";
  pick.value = params.get("pick") ?? "";
  const me = await fetch("/api/agreements");
  if (me.status === 401) {
    // not signed in: the completion of sign-in returns here — relay through the API first to validate the token exists
    state.value = "signin";
    return;
  }
  await resolve();
});

async function resolve() {
  // probe with an empty pick only to learn the offered options: the API
  // rejects a bad pick, so first ask via the token itself — simplest:
  // attempt the election; a mismatch tells us where we stand.
  await elect();
}

async function elect() {
  const res = await fetch(`/api/attribute?t=${encodeURIComponent(token.value)}&pick=${encodeURIComponent(pick.value)}`);
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status === 401) {
    state.value = "signin";
    return;
  }
  if (res.ok && json["recorded"]) {
    state.value = "recorded";
    return;
  }
  state.value = "error";
  message.value = String(json["error"] ?? "the link expired — ask the bot for a fresh one");
}
</script>

<template>
  <div class="mx-auto max-w-lg">
    <h1 class="font-sans text-2xl font-bold">Stating the agreement that covers a contribution</h1>

    <p v-if="state === 'checking'" class="mt-3 text-mist">Validating the link…</p>

    <template v-else-if="state === 'signin'">
      <p class="mt-3 text-sm leading-relaxed text-mist">
        Sign in with GitHub (the same account that authored the PR), and
        you'll return here to complete the election.
      </p>
      <a
        :href="`/signin/github`"
        class="mt-6 inline-block rounded-sm bg-[#E8EAED] px-4 py-3 font-medium text-ink hover:bg-white"
        @click="sessionStorage.setItem('cla_return', window.location.search)"
      >Sign in with GitHub</a>
    </template>

    <div v-else-if="state === 'recorded'" class="mt-6 rounded-sm border border-[#2E5B3D] bg-[#12241A] p-5 text-sm text-[#7FC497]">
      Recorded. Your pull request re-checks immediately and turns green.
    </div>
    <div v-else-if="state === 'error'" class="mt-6 rounded-sm border border-seal/50 bg-seal/10 p-5 text-sm text-[#E8A090]" role="alert">
      {{ message }}
    </div>
  </div>
</template>

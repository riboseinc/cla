<script setup lang="ts">
/** Enrollment claim: the signed link's email must be VERIFIED on the
 *  claimant's identity account — the page just relays; the gate is
 *  server-side. */
import { onMounted, ref } from "vue";

const token = ref("");
const result = ref<{ enrolled?: boolean; error?: string } | null>(null);
const checked = ref(false);

onMounted(async () => {
  token.value = new URLSearchParams(window.location.search).get("t") ?? "";
  const me = await fetch("/api/agreements");
  if (me.status === 401) {
    // sign in first, then come back with the link (it survives in the address bar)
    result.value = { error: "Sign in first (GitHub, top right), then reopen this enrollment link." };
    checked.value = true;
    return;
  }
  await claim();
});

async function claim() {
  const res = await fetch(`/api/enroll?t=${encodeURIComponent(token.value)}`);
  result.value = (await res.json()) as { enrolled?: boolean; error?: string };
  checked.value = true;
}
</script>

<template>
  <div class="mx-auto max-w-lg">
    <h1 class="font-sans text-2xl font-bold">Claiming a Point-of-Contact enrollment</h1>
    <p class="mt-3 text-sm leading-relaxed text-mist">
      This link was issued when your organization's OCLA was executed. It
      grants you the <span class="font-mono text-xs text-[#E8EAED]">org_admin</span>
      role — but only when the identity account you're signed in with has
      the <strong class="text-[#E8EAED]">invited email verified</strong>.
    </p>
    <p v-if="!token" class="mt-6 text-sm text-caution">This page needs a link (<code>?t=…</code>) from your organization's signatory or from Ribose staff.</p>
    <template v-else-if="checked && result">
      <div v-if="result.enrolled" class="mt-6 rounded-sm border border-[#2E5B3D] bg-[#12241A] p-5 text-sm text-[#7FC497]">
        Enrolled. Open <a class="underline" href="/admin-orgs">your PoC console</a> to manage Schedule A and approvals.
      </div>
      <div v-else class="mt-6 rounded-sm border border-seal/50 bg-seal/10 p-5 text-sm text-[#E8A090]" role="alert">
        {{ result.error }}
      </div>
    </template>
    <p v-else class="mt-6 text-mist">Checking the link…</p>
  </div>
</template>

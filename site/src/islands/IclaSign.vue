<script setup lang="ts">
/** The ICLA signing island. The agreement is rendered as a document;
 *  the signature block follows it, as it would on paper. Every state
 *  is stated honestly: the surface reports what is missing and what is
 *  recorded. */
import { computed, onMounted, ref } from "vue";

type Phase = "checking" | "signin" | "form" | "done" | "error";
const phase = ref<Phase>("checking");
const bound = ref<{ github_login: string; email: string | null; email_verified: boolean } | null>(null);
const edition = ref<{ version: string; sha256: string; text: string } | null>(null);
const paragraphs = ref<string[]>([]);
const terms = ref(false);
const past = ref<"unset" | "yes" | "no">("unset");
const name = ref("");
const email = ref("");
const altEmail = ref("");
const country = ref("");
const error = ref("");
const signedRecord = ref("");
const today = new Date().toISOString().slice(0, 10);

onMounted(async () => {
  const editions = await fetch("/api/editions").then((r) => r.json());
  const current = editions.icla;
  const text = await fetch(`/api/agreements/text/icla/${current.version}`).then((r) => r.json());
  edition.value = text;
  paragraphs.value = (text.text as string).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const me = await fetch("/api/agreements");
  if (me.status === 401) {
    phase.value = "signin";
    return;
  }
  bound.value = (await me.json()) as { github_login: string; email: string | null; email_verified: boolean };
  name.value = bound.value.github_login;
  email.value = bound.value.email ?? "";
  phase.value = "form";
});

async function sign() {
  error.value = "";
  const body = new URLSearchParams({
    csrf: "",
    terms: terms.value ? "on" : "",
    past: past.value === "yes" ? "yes" : "",
    past_declined: past.value === "no" ? "yes" : "",
    name: name.value,
    email: email.value,
    alt_email: altEmail.value,
    country: country.value,
  });
  const res = await fetch("/api/icla/sign", { method: "POST", body });
  const json = (await res.json()) as Record<string, unknown>;
  if (res.ok && json["signed"]) {
    signedRecord.value = String(json["record"]);
    phase.value = "done";
  } else {
    error.value = String(json["error"] ?? `signing failed (${res.status})`);
  }
}
const canSign = computed(() => terms.value && past.value !== "unset" && name.value.length > 0 && email.value.length > 0 && country.value.length > 0);
</script>

<template>
  <p v-if="phase === 'checking'" class="text-slate-500 dark:text-slate-400">The agreement is being loaded.</p>

  <!-- The contributor has not proven a GitHub handle yet. -->
  <template v-else-if="phase === 'signin'">
    <p class="font-mono text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
      Individual Contributor License Agreement · edition {{ edition?.version }}
    </p>
    <h1 class="mt-3 font-sans text-2xl font-bold">Signing requires a verified GitHub handle</h1>
    <p class="mt-4 max-w-2xl text-base leading-relaxed">
      The service records a signature only after the contributor has proven
      ownership of the GitHub handle under which contributions are made. The
      proof happens through GitHub itself, and the handle is bound at the
      same time to a Ribose ID account, which is created automatically for
      contributors who do not hold one.
    </p>
    <a
      href="/signin/github"
      class="mt-6 inline-block rounded-sm bg-brand-500 px-5 py-3 font-semibold text-ink transition-colors hover:bg-brand-400"
    >
      Sign in with GitHub
    </a>
    <p class="mt-4 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
      The full text of the agreement is available below, and it can be read
      before signing.
    </p>
    <div class="mt-8 rounded-sm border border-line bg-paper p-8 dark:border-ink-2 dark:bg-ink-2">
      <h2 class="text-center font-sans text-lg font-bold text-ink dark:text-slate-100">
        Individual Contributor License Agreement
      </h2>
      <p class="mt-1 text-center font-mono text-xs text-slate-500 dark:text-slate-400">
        version {{ edition?.version }} · sha256 {{ edition?.sha256 }}
      </p>
      <div class="mt-6 space-y-4">
        <p v-for="(p, i) in paragraphs" :key="i" class="text-[15px] leading-relaxed text-ink dark:text-slate-200">{{ p }}</p>
      </div>
    </div>
  </template>

  <!-- The signing page: the document, then the signature block. -->
  <template v-else-if="phase === 'form'">
    <p class="font-mono text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
      Individual Contributor License Agreement · edition {{ edition?.version }}
    </p>
    <h1 class="mt-3 font-sans text-2xl font-bold">Signing page</h1>

    <div class="mt-6 grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div>
        <div class="rounded-sm border border-line bg-paper p-8 dark:border-ink-2 dark:bg-ink-2">
          <h2 class="text-center font-sans text-lg font-bold text-ink dark:text-slate-100">
            Individual Contributor License Agreement
          </h2>
          <p class="mt-1 text-center font-mono text-xs text-slate-500 dark:text-slate-400">
            version {{ edition?.version }} · sha256 {{ edition?.sha256 }}
          </p>
          <div class="mt-6 space-y-4">
            <p v-for="(p, i) in paragraphs" :key="i" class="text-[15px] leading-relaxed text-ink dark:text-slate-200">{{ p }}</p>
          </div>
        </div>
      </div>

      <aside>
        <div class="rounded-sm border border-line p-6 dark:border-ink-2">
          <h2 class="font-sans text-base font-bold">Signature</h2>

          <dl class="mt-4 space-y-1 border-b border-line pb-4 text-sm">
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500 dark:text-slate-400">GitHub handle</dt>
              <dd class="font-mono text-ink dark:text-slate-100">@{{ bound?.github_login }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500 dark:text-slate-400">Ribose ID</dt>
              <dd class="font-mono text-xs text-ink dark:text-slate-100">{{ bound ? "bound" : "—" }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500 dark:text-slate-400">Date</dt>
              <dd class="text-ink dark:text-slate-100">{{ today }}</dd>
            </div>
          </dl>

          <div class="mt-5 space-y-3 text-sm">
            <label class="block">
              <span class="text-slate-500 dark:text-slate-400">Full name</span>
              <input v-model="name" type="text" required class="mt-1 w-full rounded-sm border border-line bg-paper px-3 py-2 text-ink focus:border-brand-500 focus:outline-none dark:border-ink-2 dark:bg-ink dark:text-slate-100" />
            </label>
            <label class="block">
              <span class="text-slate-500 dark:text-slate-400">Email</span>
              <input v-model="email" type="email" required class="mt-1 w-full rounded-sm border border-line bg-paper px-3 py-2 text-ink focus:border-brand-500 focus:outline-none dark:border-ink-2 dark:bg-ink dark:text-slate-100" />
            </label>
            <label class="block">
              <span class="text-slate-500 dark:text-slate-400">Alternative email</span>
              <input v-model="altEmail" type="email" class="mt-1 w-full rounded-sm border border-line bg-paper px-3 py-2 focus:border-brand-500 focus:outline-none dark:border-ink-2 dark:bg-ink dark:text-slate-100" />
            </label>
            <label class="block">
              <span class="text-slate-500 dark:text-slate-400">Country</span>
              <input v-model="country" type="text" required class="mt-1 w-full rounded-sm border border-line bg-paper px-3 py-2 text-ink focus:border-brand-500 focus:outline-none dark:border-ink-2 dark:bg-ink dark:text-slate-100" />
            </label>
          </div>

          <div class="mt-5 space-y-3 border-t border-line pt-5 text-sm leading-relaxed">
            <label class="flex items-start gap-2.5">
              <input v-model="terms" type="checkbox" class="mt-1 accent-[#04a9c0]" />
              <span>I accept the terms of the agreement that is printed on this page, and I confirm that the identity fields above are correct.</span>
            </label>
            <label class="flex items-start gap-2.5">
              <input v-model="past" type="radio" value="yes" class="mt-1 accent-[#04a9c0]" />
              <span>The agreement covers all of my previous contributions to the projects of Ribose.</span>
            </label>
            <label class="flex items-start gap-2.5">
              <input v-model="past" type="radio" value="no" class="mt-1 accent-[#04a9c0]" />
              <span class="text-slate-500 dark:text-slate-400">The agreement does not cover my previous contributions. The record states this exclusion.</span>
            </label>
          </div>

          <p v-if="error" class="mt-4 rounded-sm border border-accent-600/50 bg-accent-600/10 px-3 py-2 text-sm text-accent-600 dark:text-accent-400" role="alert">{{ error }}</p>

          <button
            :disabled="!canSign"
            class="mt-5 w-full rounded-sm bg-brand-500 px-4 py-3 font-semibold text-ink transition-colors hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-40"
            @click="sign"
          >
            Sign the agreement
          </button>
          <p class="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            The service records the signature as an append-only entry that
            carries the identity fields above, the edition of the agreement,
            and the SHA-256 hash of its text. The entry cannot be changed
            after it is recorded; a correction is recorded as a new entry.
          </p>
        </div>
      </aside>
    </div>
  </template>

  <!-- Recorded -->
  <template v-else-if="phase === 'done'">
    <div class="mx-auto max-w-xl rounded-sm border border-line bg-paper p-8 text-center dark:border-ink-2 dark:bg-ink-2">
      <h1 class="font-sans text-2xl font-bold">The signature has been recorded.</h1>
      <p class="mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
        The record is
        <span class="font-mono text-xs text-ink dark:text-slate-100">{{ signedRecord }}</span>.
        The service applies the agreement to the pull requests of the
        contributor at the next evaluation, and the record remains visible
        on the agreements page.
      </p>
      <a href="/agreements" class="mt-6 inline-block text-sm text-brand-600 dark:text-brand-400 hover:underline">Open the agreements page</a>
    </div>
  </template>

  <p v-else class="text-slate-500 dark:text-slate-400">{{ error }}</p>
</template>

<script setup lang="ts">
/** The ICLA signing island: session → edition text on paper → two
 *  consents → the signature line. Honest states throughout. */
import { computed, onMounted, ref } from "vue";

type Phase = "checking" | "signin" | "form" | "done" | "error";
const phase = ref<Phase>("checking");
const dark = ref(false);
const bound = ref<{ github_login: string; email: string | null; email_verified: boolean } | null>(null);
const edition = ref<{ version: string; sha256: string; text: string } | null>(null);
const terms = ref(false);
const past = ref<"unset" | "yes" | "no">("unset");
const name = ref("");
const email = ref("");
const altEmail = ref("");
const country = ref("");
const error = ref("");
const signedRecord = ref("");

onMounted(async () => {
  const editions = await fetch("/api/editions").then((r) => r.json());
  const current = editions.icla;

  // The edition text is public: render the paper before sign-in.
  const text = await fetch(`/api/agreements/text/icla/${current.version}`);
  if (text.ok) edition.value = await text.json();

  const me = await fetch("/api/agreements");
  if (me.status === 404) {
    // The portal is not armed yet: the paper is readable, signing is not.
    dark.value = true;
    phase.value = "signin";
    return;
  }
  if (me.status === 401) {
    phase.value = "signin";
    return;
  }
  if (!me.ok) {
    error.value = `The portal answered ${me.status}.`;
    phase.value = "error";
    return;
  }

  // /agreements returns {bound:{...}, email, email_verified, ...}
  const body = (await me.json()) as {
    bound?: { github_login?: string };
    email?: string | null;
    email_verified?: boolean;
  };
  bound.value = {
    github_login: body.bound?.github_login ?? "",
    email: body.email ?? null,
    email_verified: body.email_verified === true,
  };
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
const canSign = computed(() => terms.value && past.value !== "unset");
</script>

<template>
  <!-- checking -->
  <p v-if="phase === 'checking'" class="text-mist">Reading the instrument…</p>

  <!-- not signed in: the paper is shown, the line waits -->
  <template v-else-if="phase === 'signin'">
    <div class="grid gap-8 md:grid-cols-[1fr_300px]">
      <div class="relative border-l-4 border-seal bg-paper px-8 py-8 text-paper-ink">
        <div class="absolute -right-3 top-6 hidden rotate-90 md:block">
          <span class="font-mono text-[10px] uppercase tracking-[0.25em] text-paper-ink/60">
            ICLA {{ edition?.version }} · sha256 {{ edition?.sha256 }}
          </span>
        </div>
        <pre class="whitespace-pre-wrap font-serif text-[15px] leading-relaxed">{{ edition?.text }}</pre>
        <p class="mt-6 font-mono text-xs text-paper-ink/60">sha256 {{ edition?.sha256 }}</p>
      </div>
      <aside class="space-y-4">
        <h1 class="font-serif text-2xl font-semibold">Sign the ICLA</h1>
        <p v-if="dark" class="text-sm leading-relaxed text-mist">
          The signing portal is not open yet. The agreement text is shown
          for review; sign-in opens once the portal is connected.
        </p>
        <template v-else>
          <p class="text-sm leading-relaxed text-mist">
            First, prove your GitHub handle. You'll come straight back to
            this signature line.
          </p>
          <a
            href="/signin/github"
            class="inline-flex w-full items-center justify-center gap-2 rounded-sm bg-[#E8EAED] px-4 py-3 font-medium text-ink transition-colors hover:bg-white"
          >
            <svg viewBox="0 0 16 16" class="h-5 w-5 fill-current" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
            Sign in with GitHub
          </a>
          <p class="text-xs leading-relaxed text-mist">
            You'll pass through your Ribose ID (created automatically if
            you don't have one) — that's what binds this signature to a
            durable identity, not just a handle.
          </p>
        </template>
      </aside>
    </div>
  </template>

  <!-- the instrument -->
  <template v-else-if="phase === 'form'">
    <h1 class="font-serif text-2xl font-semibold">Sign the Individual CLA — v{{ edition?.version }}</h1>
    <p class="mt-2 text-sm text-mist">
      Signing as
      <strong class="text-[#E8EAED]">@{{ bound?.github_login }}</strong>
      <template v-if="bound?.email">
        ({{ bound?.email }}{{ bound?.email_verified ? ", verified" : ", unverified" }})
      </template>
    </p>

    <div class="mt-6 grid gap-8 md:grid-cols-[1fr_300px]">
      <div class="relative border-l-4 border-seal bg-paper px-8 py-8 text-paper-ink">
        <div class="absolute -right-3 top-6 hidden rotate-90 md:block">
          <span class="font-mono text-[10px] uppercase tracking-[0.25em] text-paper-ink/60">
            ICLA {{ edition?.version }} · sha256 {{ edition?.sha256 }}
          </span>
        </div>
        <pre class="whitespace-pre-wrap font-serif text-[15px] leading-relaxed">{{ edition?.text }}</pre>
      </div>

      <aside class="space-y-6">
        <div class="space-y-3 text-sm">
          <label class="block">
            <span class="text-mist">Name</span>
            <input v-model="name" type="text" class="mt-1 w-full rounded-sm border border-rule bg-ground-2 px-3 py-2 text-[#E8EAED] focus:border-seal focus:outline-none" />
          </label>
          <label class="block">
            <span class="text-mist">Email</span>
            <input v-model="email" type="email" class="mt-1 w-full rounded-sm border border-rule bg-ground-2 px-3 py-2 text-[#E8EAED] focus:border-seal focus:outline-none" />
          </label>
          <label class="block">
            <span class="text-mist">Alternative email</span>
            <input v-model="altEmail" type="email" class="mt-1 w-full rounded-sm border border-rule bg-ground-2 px-3 py-2 text-[#E8EAED] focus:border-seal focus:outline-none" />
          </label>
          <label class="block">
            <span class="text-mist">Country</span>
            <input v-model="country" type="text" class="mt-1 w-full rounded-sm border border-rule bg-ground-2 px-3 py-2 text-[#E8EAED] focus:border-seal focus:outline-none" />
          </label>
        </div>

        <div class="space-y-3 border-t border-rule pt-4 text-sm">
          <label class="flex items-start gap-2.5">
            <input v-model="terms" type="checkbox" class="mt-0.5 accent-[#B8452E]" />
            <span class="leading-relaxed">
              I agree to the terms above — edition
              <span class="font-mono text-xs">{{ edition?.version }}</span>,
              <span class="font-mono text-xs">{{ edition?.sha256?.slice(0, 16) }}…</span>
            </span>
          </label>
          <label class="flex items-start gap-2.5">
            <input v-model="past" type="radio" value="yes" class="mt-0.5 accent-[#B8452E]" />
            <span class="leading-relaxed">This agreement includes <strong>all</strong> my previous contributions to Ribose projects</span>
          </label>
          <label class="flex items-start gap-2.5">
            <input v-model="past" type="radio" value="no" class="mt-0.5 accent-[#B8452E]" />
            <span class="leading-relaxed text-mist">Exclude my previous contributions (recorded visibly)</span>
          </label>
        </div>

        <p v-if="error" class="rounded-sm border border-seal/50 bg-seal/10 px-3 py-2 text-sm text-[#E8A090]" role="alert">{{ error }}</p>

        <!-- the signature line: you sign above the line -->
        <div class="border-t border-rule pt-5">
          <button
            :disabled="!canSign"
            class="w-full rounded-sm bg-seal px-4 py-3 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            @click="sign"
          >
            Sign the agreement
          </button>
          <p class="mt-2 text-center font-mono text-[11px] text-mist">· · · sign above the line · · ·</p>
        </div>
      </aside>
    </div>
  </template>

  <!-- signed -->
  <template v-else-if="phase === 'done'">
    <div class="mx-auto max-w-md rounded-sm border border-rule bg-ground-2 p-8 text-center">
      <span class="mx-auto block h-3 w-3 rounded-[2px] bg-seal" aria-hidden="true"></span>
      <h1 class="mt-4 font-serif text-2xl font-semibold">Signed.</h1>
      <p class="mt-3 text-sm leading-relaxed text-mist">
        Your ICLA is recorded (append-only)
        <span class="font-mono text-xs text-[#E8EAED]">{{ signedRecord }}</span>.
        Your next pull request turns green on its own.
      </p>
      <a href="/agreements" class="mt-6 inline-block text-sm text-seal hover:underline">View my agreements →</a>
    </div>
  </template>

  <p v-else class="text-mist">{{ error }}</p>
</template>

<script setup lang="ts">
/** The ICLA signing island: session → edition text on paper → two
 *  consents → the signature line. Honest states throughout. */
import { computed, nextTick, onMounted, ref } from "vue";

type Phase = "checking" | "signin" | "form" | "signed" | "done" | "error";
const phase = ref<Phase>("checking");
const dark = ref(false);
const bound = ref<{ github_login: string; email: string | null; email_verified: boolean } | null>(null);
const edition = ref<{ version: string; sha256: string; text: string } | null>(null);
const signedCurrent = ref<{ version: string; sha256: string } | null>(null);
const terms = ref(false);
const name = ref("");
const altEmail = ref("");
const country = ref("");
const showAltEmail = ref(false);
const showCountry = ref(false);

const error = ref("");
const signedRecord = ref("");

/** Double-submit CSRF: the token cookie is readable by this page (never HttpOnly). */
const csrfToken = (): string => document.cookie.match(/cla_csrf=([^;]+)/)?.[1] ?? "";


onMounted(async () => {
  const editions = await fetch("/api/editions").then((r) => r.json());
  const current = editions.icla;

  // The edition text is public: render the paper before sign-in.
  const text = await fetch(`/api/agreements/text/icla/${current.version}`);
  if (text.ok) {
    edition.value = await text.json();
  }

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

  // /agreements returns {bound:{...}, email, email_verified, iclaSignatures, ...}
  const body = (await me.json()) as {
    bound?: { github_login?: string };
    name?: string | null;
    email?: string | null;
    email_verified?: boolean;
    iclaSignatures?: Array<{ current: boolean; edition: { version: string; textSha256: string } }>;
  };
  bound.value = {
    github_login: body.bound?.github_login ?? "",
    email: body.email ?? null,
    email_verified: body.email_verified === true,
  };
  const currentSig = (body.iclaSignatures ?? []).find((s) => s.current);
  if (currentSig) {
    // A live current-edition signature already exists: the form would
    // only produce a duplicate record, so the page reports the state.
    signedCurrent.value = { version: currentSig.edition.version, sha256: currentSig.edition.textSha256 };
    phase.value = "signed";
    return;
  }
  name.value = (body.name ?? "").trim();
  phase.value = "form";
  void nextTick(observePaperEnd);
});

async function sign() {
  error.value = "";
  const body = new URLSearchParams({
    csrf: csrfToken(),
    terms: "on",
    // The Agreement includes all previous contributions: exclusion is not
    // allowed and the signature affirms inclusion (no election to make).
    past: "yes",
    name: name.value,
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
const canSign = computed(() => name.value.trim().length > 0 && readTheAgreement.value);

// The signing conditions, as live ticks: the signer sees what is done
// and what is left.
const conditions = computed(() => [
  { done: readTheAgreement.value, label: "Scroll down through the full Agreement" },
  { done: name.value.trim().length > 0, label: "Write your full legal name" },
]);

// The legal-UI contract: the signature unlocks only after the end of
// the instrument has actually been on screen — by scrolling the paper,
// by scrolling the page, or because the document fits. The observer
// watches the provenance line; the scroll handler covers the paper's
// own inner scroller.
const endMarkEl = ref<HTMLElement | null>(null);
const readTheAgreement = ref(false);
let endObserver: IntersectionObserver | undefined;
// The instrument text carries one paragraph per line (the counsel
// 1.0 shape): render line-by-line with paragraph margins between all
// of them. The trailing identity block is NOT rendered — the
// interactive record card beside the paper is that block.
const lines = computed(() =>
  (edition.value?.text ?? "")
    .split("\n")
    .filter((line) => !/^\s*(GitHub Username|Name|Email|Alternative email|Country):\s*$/.test(line)),
);
function observePaperEnd(): void {
  endObserver?.disconnect();
  const el = endMarkEl.value;
  if (el === null) return;
  endObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        readTheAgreement.value = true;
        endObserver?.disconnect();
      }
    },
    { threshold: 1 },
  );
  endObserver.observe(el);
}
</script>

<template>
  <!-- checking -->
  <p v-if="phase === 'checking'" class="text-slate-500 dark:text-slate-400">
    The Agreement is loading. The signing form appears below it.
  </p>

  <!-- not signed in: the paper is shown, the line waits -->
  <template v-else-if="phase === 'signin'">
    <div class="grid gap-8 md:grid-cols-[minmax(0,1.9fr)_minmax(280px,1fr)]">
      <div class="relative border-l-4 border-brand-400 bg-paper px-8 py-8 text-paper-ink">
        <pre class="whitespace-pre-wrap font-serif text-[15px] leading-relaxed">{{ edition?.text }}</pre>
        <p ref="endMarkEl" class="mt-6 font-mono text-xs text-paper-ink/60">ICLA v{{ edition?.version }} · sha256 {{ edition?.sha256 }} — end of the Agreement</p>
      </div>
      <aside class="space-y-4">
        <h1 class="font-serif text-2xl font-semibold">Sign the ICLA</h1>
        <p v-if="dark" class="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          The signing portal is not open yet. The agreement text is shown
          for review; sign-in opens once the portal is connected.
        </p>
        <template v-else>
          <div class="space-y-3 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            <div class="rounded-sm border border-rule bg-white dark:bg-ink-2 p-4 text-ink dark:text-white">
              <p class="font-medium">The effect of signature depends on Your standing:</p>
              <p class="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                If You are Ribose staff, or a party to an existing contractor or service agreement
                with Ribose, signing establishes solely the association between Your GitHub account
                and this CLA system; it creates no additional claims and does not modify, supersede,
                or otherwise affect any rights or obligations arising under any such existing agreement.
              </p>
              <p class="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                For any other Contributor, signing constitutes Your acceptance of this Agreement and
                grants the licenses set forth in its text, shown in full on this page.
              </p>
              <p class="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                In either case, one signature covers Your contributions to all Ribose organizations
                on GitHub.
              </p>
            </div>
            <p>
              Signing verifies two identities in one pass: the GitHub handle,
              through GitHub itself, and the Ribose ID account — created
              automatically when none exists — which holds the association
              permanently.
            </p>
          </div>
          <a
            href="/signin/github"
            class="inline-flex w-full items-center justify-center gap-2 rounded-sm bg-ink dark:bg-white px-4 py-3 font-medium text-ink transition-colors hover:bg-white"
          >
            <svg viewBox="0 0 16 16" class="h-5 w-5 fill-current" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
            Sign in with GitHub
          </a>
          <p class="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            The signature line returns after both verifications complete.
          </p>
        </template>
      </aside>
    </div>
  </template>

  <!-- already signed: the record card replaces the form -->
  <template v-else-if="phase === 'signed'">
    <div class="grid gap-8 md:grid-cols-[minmax(0,1.9fr)_minmax(280px,1fr)]">
      <div class="relative border-l-4 border-brand-400 bg-paper px-8 py-8 text-paper-ink">
        <pre class="whitespace-pre-wrap font-serif text-[15px] leading-relaxed">{{ edition?.text }}</pre>
        <p class="mt-6 font-mono text-xs text-paper-ink/60">ICLA v{{ edition?.version }} · sha256 {{ edition?.sha256 }} — end of the Agreement</p>
      </div>
      <aside class="space-y-4">
        <h1 class="font-serif text-2xl font-semibold">Already signed</h1>
        <div class="rounded-sm border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-900/30">
          <p class="font-medium text-emerald-800 dark:text-emerald-300">
            Your signature of the Individual Contributor License Agreement
            v{{ signedCurrent?.version }} is on record.
          </p>
          <p class="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            <span class="font-mono">@{{ bound?.github_login }}</span> — one signature covers your
            contributions to all Ribose organizations on GitHub. The exact
            signed text and its hash are on your agreements page.
          </p>
        </div>
        <p class="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          You sign again only when counsel publishes a new edition of the
          Agreement; enforcement tells you on the pull request when that
          happens.
        </p>
        <a
          href="/agreements"
          class="inline-flex w-full items-center justify-center rounded-sm bg-ink dark:bg-white px-4 py-3 font-medium text-ink dark:text-white no-underline transition-colors hover:bg-white dark:hover:bg-slate-200"
        >Open my agreements</a>
      </aside>
    </div>
  </template>

  <!-- the instrument -->
  <template v-else-if="phase === 'form'">
    <h1 class="font-serif text-2xl font-semibold">Sign the Individual CLA — v{{ edition?.version }}</h1>
    <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">
      Signing as
      <strong class="text-ink dark:text-white">@{{ bound?.github_login }}</strong>
    </p>
    <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
      <template v-if="bound?.email">{{ bound?.email }} — {{ bound?.email_verified ? "verified" : "unverified" }}<template v-if="!bound?.email_verified"> — <a class="underline underline-offset-2" href="https://id.ribose.com/account">verify it in your Ribose ID account console</a></template></template>
      <template v-else>no email on the identity account</template>
    </p>

    <div class="mt-6 grid gap-8 md:grid-cols-[minmax(0,1.9fr)_minmax(280px,1fr)]">
      <div
        ref="paperEl"
        class="relative border-l-4 border-brand-400 bg-paper px-8 py-8 text-paper-ink"
      >
        <div v-if="!readTheAgreement" class="fixed inset-x-0 top-16 z-30 bg-brand-500 px-6 py-2.5 text-center text-sm font-medium text-white">
          <span class="mr-2 inline-block animate-pulse" aria-hidden="true">↓</span>
          Scroll down through the full Agreement — the AGREE button unlocks at its end.
        </div>
        <p
          v-for="(line, i) in lines"
          :key="i"
          class="mb-5 whitespace-pre-line font-serif text-[15px] leading-relaxed last:mb-0"
        >{{ line }}</p>
        <p ref="endMarkEl" class="mt-6 font-mono text-xs text-paper-ink/60">ICLA v{{ edition?.version }} · sha256 {{ edition?.sha256 }} — end of the Agreement</p>
      </div>

      <aside class="space-y-5 md:sticky md:top-24 md:self-start">
        <div class="space-y-2 text-sm">
          <p class="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">The record — Agreement §Identity</p>
          <div class="flex items-center justify-between gap-3 rounded-sm border border-rule bg-white dark:bg-ink-2 px-3 py-2">
            <span class="text-slate-500 dark:text-slate-400">GitHub Username</span>
            <span class="font-mono text-ink dark:text-white">{{ bound?.github_login }}</span>
            <span class="text-xs text-emerald-600 dark:text-emerald-400" title="Proven by the GitHub round">confirmed</span>
          </div>
          <div class="flex items-center justify-between gap-3 rounded-sm border border-rule bg-white dark:bg-ink-2 px-3 py-2">
            <span class="text-slate-500 dark:text-slate-400">Email</span>
            <span class="font-mono text-ink dark:text-white">{{ bound?.email || "—" }}</span>
            <span :class="bound?.email_verified ? 'text-xs text-emerald-600 dark:text-emerald-400' : 'text-xs text-amber-600 dark:text-amber-400'">{{ bound?.email_verified ? "confirmed" : "unverified" }}</span>
          </div>
          <label class="block rounded-sm border border-brand-400 bg-white dark:bg-ink-2 px-3 py-2">
            <span class="text-slate-500 dark:text-slate-400">Name — type it; it is the signature</span>
            <input v-model="name" type="text" autocomplete="name" placeholder="Your full legal name" class="mt-1 w-full bg-transparent text-ink dark:text-white placeholder:text-slate-400 focus:outline-none" />
          </label>
          <label v-if="showAltEmail" class="block rounded-sm border border-rule bg-white dark:bg-ink-2 px-3 py-2">
            <span class="text-slate-500 dark:text-slate-400">Alternative email</span>
            <input v-model="altEmail" type="email" placeholder="optional" class="mt-1 w-full bg-transparent text-ink dark:text-white placeholder:text-slate-400 focus:outline-none" />
          </label>
          <label v-if="showCountry" class="block rounded-sm border border-rule bg-white dark:bg-ink-2 px-3 py-2">
            <span class="text-slate-500 dark:text-slate-400">Country</span>
            <input v-model="country" type="text" placeholder="optional" class="mt-1 w-full bg-transparent text-ink dark:text-white placeholder:text-slate-400 focus:outline-none" />
          </label>
          <p v-if="!showAltEmail || !showCountry" class="text-xs text-slate-500 dark:text-slate-400">
            <button v-if="!showAltEmail" type="button" class="text-brand-600 underline underline-offset-2 dark:text-brand-400" @click="showAltEmail = true">+ add alternative email</button>
            <span v-if="!showAltEmail && !showCountry" class="mx-1">·</span>
            <button v-if="!showCountry" type="button" class="text-brand-600 underline underline-offset-2 dark:text-brand-400" @click="showCountry = true">+ add country</button>
            <span class="text-slate-400"> (optional)</span>
          </p>
        </div>

        <ul class="space-y-2 border-t border-rule pt-4 text-sm" aria-label="Signing conditions">
          <li v-for="c in conditions" :key="c.label" class="flex items-center gap-2.5">
            <span
              :class="c.done ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-300 dark:text-slate-600'"
              aria-hidden="true"
            >{{ c.done ? "✓" : "○" }}</span>
            <span :class="c.done ? 'text-ink dark:text-white' : 'text-slate-500 dark:text-slate-400'">{{ c.label }}</span>
          </li>
        </ul>

        <p class="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          The Agreement includes all previous contributions to Ribose
          projects — edition {{ edition?.version }}.
        </p>
        <p class="border-t border-rule pt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          If You are Ribose staff, or a party to an existing contractor or service
          agreement with Ribose, this signature establishes solely the association
          between Your GitHub account and this CLA system; it creates no additional
          claims and does not modify, supersede, or otherwise affect any rights or
          obligations arising under any such existing agreement.
        </p>


        <button
          :disabled="!canSign"
          class="w-full rounded-sm bg-brand-500 px-4 py-3 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          @click="sign"
        >
          AGREE
        </button>
        <p v-if="error" class="rounded-sm border border-accent-600/40 bg-accent-600/10 px-3 py-2 text-sm text-accent-600 dark:text-accent-400" role="alert">{{ error }}</p>


      </aside>
    </div>
  </template>

  <!-- signed -->
  <template v-else-if="phase === 'done'">
    <div class="mx-auto max-w-md rounded-sm border border-rule bg-white dark:bg-ink-2 p-8 text-center">
      <span class="mx-auto block h-3 w-3 rounded-[2px] bg-brand-500" aria-hidden="true"></span>
      <h1 class="mt-4 font-serif text-2xl font-semibold">Signed.</h1>
      <p v-if="name.trim()" class="mt-2 font-serif text-xl italic">— {{ name.trim() }}</p>
      <p class="mt-3 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        This Agreement is recorded append-only as
        <span class="font-mono text-xs text-ink dark:text-white">{{ signedRecord }}</span>.
        One signature covers Your contributions to <strong>all Ribose organizations on GitHub</strong> —
        your next pull request turns green on its own.
      </p>
      <a href="/agreements" class="mt-6 inline-block text-sm text-brand-600 dark:text-brand-400 hover:underline">View my agreements</a>
    </div>
  </template>

  <p v-else class="text-slate-500 dark:text-slate-400">{{ error }}</p>
</template>

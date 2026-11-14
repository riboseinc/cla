<script setup lang="ts">
/** The OCLA execution island: company + declared domains, the
 *  on-domain verified-mailbox gate, live Schedule-A resolution. */
import { computed, onMounted, ref } from "vue";

type Phase = "checking" | "signin" | "form" | "done" | "error";
const phase = ref<Phase>("checking");
const me = ref<{ login: string; email: string | null; emailVerified: boolean } | null>(null);
const edition = ref<{ version: string; sha256: string; text: string } | null>(null);
const orgName = ref("");
const orgAddress = ref("");
const orgCountry = ref("");
const domains = ref("");
const signatoryName = ref("");
const signatoryEmail = ref("");
const signatoryTitle = ref("");
const signatoryGithub = ref("");
const pocName = ref("");
const pocEmail = ref("");
const pocPhone = ref("");
const scheduleA = ref("");
const terms = ref(false);
const past = ref(false);
const error = ref("");
const done = ref<{ oclaId: string; orgSlug: string; coveredCount: number; pocEnrollmentUrl: string } | null>(null);

const domainList = computed(() => domains.value.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean));
const sessionEmailDomain = computed(() => me.value?.email?.split("@")[1]?.toLowerCase());
const gateOk = computed(() => Boolean(me.value?.emailVerified && sessionEmailDomain.value && domainList.value.includes(sessionEmailDomain.value)));
const pocOnDomain = computed(() => domainList.value.includes(pocEmail.value.split("@")[1]?.toLowerCase() ?? ""));
const signatoryOnDomain = computed(() => domainList.value.includes(signatoryEmail.value.split("@")[1]?.toLowerCase() ?? ""));
const rows = computed(() => scheduleA.value.split("\n").map((l) => l.trim()).filter(Boolean));
const canSign = computed(() => terms.value && orgName.value && domainList.value.length > 0 && pocOnDomain.value && signatoryOnDomain.value && rows.value.length > 0);

onMounted(async () => {
  const editions = await fetch("/api/editions").then((r) => r.json());
  edition.value = await fetch(`/api/agreements/text/ocla/${editions.ocla.version}`).then((r) => r.json());
  const res = await fetch("/api/agreements");
  if (res.status === 401) {
    phase.value = "signin";
    return;
  }
  const body = (await res.json()) as { bound: { github_login: string }; email: string | null; email_verified: boolean };
  me.value = { login: body.bound.github_login, email: body.email, emailVerified: body.email_verified };
  signatoryEmail.value = body.email ?? "";
  phase.value = "form";
});

async function sign() {
  error.value = "";
  const body = new URLSearchParams({
    csrf: "",
    terms: "on",
    past: past.value ? "yes" : "",
    org_name: orgName.value,
    org_address: orgAddress.value,
    org_country: orgCountry.value,
    domains: domainList.value.join(", "),
    signatory_name: signatoryName.value,
    signatory_email: signatoryEmail.value,
    signatory_title: signatoryTitle.value,
    signatory_github: signatoryGithub.value,
    poc_name: pocName.value,
    poc_email: pocEmail.value,
    poc_phone: pocPhone.value,
    schedule_a: rows.value.join("\n"),
  });
  const res = await fetch("/api/sign-ocla", { method: "POST", body });
  const json = (await res.json()) as Record<string, unknown>;
  if (res.ok && json["signed"]) {
    done.value = json as never;
    phase.value = "done";
  } else {
    error.value = String(json["error"] ?? `execution failed (${res.status})`);
  }
}
</script>

<template>
  <p v-if="phase === 'checking'" class="text-slate-500 dark:text-slate-400">Reading the instrument…</p>

  <template v-else-if="phase === 'signin'">
    <h1 class="font-serif text-2xl font-semibold">Execute an Organization CLA</h1>
    <p class="mt-3 max-w-xl text-sm leading-relaxed text-slate-500 dark:text-slate-400">
      The signatory signs in first — through your organization's identity
      account so the on-domain mailbox gate can hold. You need a
      <strong class="text-ink dark:text-white">verified mailbox on the company's domain</strong>
      before the signing step unlocks.
    </p>
    <a href="/signin/github" class="mt-6 inline-block rounded-sm bg-ink dark:bg-white px-4 py-3 font-medium text-ink hover:bg-white">Sign in</a>
  </template>

  <template v-else-if="phase === 'form'">
    <h1 class="font-serif text-2xl font-semibold">Execute an Organization CLA — v{{ edition?.version }}</h1>
    <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">
      The signatory is <strong class="text-ink dark:text-white">@{{ me?.login }}</strong>
      <template v-if="me?.email"> ({{ me?.email }}{{ me?.emailVerified ? ", verified" : ", UNVERIFIED" }})</template>
    </p>

    <div class="mt-6 grid gap-8 lg:grid-cols-[1fr_360px]">
      <div class="space-y-6">
        <section class="rounded-sm border border-rule bg-white dark:bg-ink-2 p-6">
          <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">company</h2>
          <div class="mt-4 grid gap-3 md:grid-cols-2">
            <label class="text-sm"><span class="text-slate-500 dark:text-slate-400">Legal name</span>
              <input v-model="orgName" class="mt-1 w-full rounded-sm border border-rule bg-ink px-3 py-2 focus:border-brand-500 focus:outline-none" /></label>
            <label class="text-sm"><span class="text-slate-500 dark:text-slate-400">Country</span>
              <input v-model="orgCountry" class="mt-1 w-full rounded-sm border border-rule bg-ink px-3 py-2 focus:border-brand-500 focus:outline-none" /></label>
            <label class="text-sm md:col-span-2"><span class="text-slate-500 dark:text-slate-400">Address</span>
              <input v-model="orgAddress" class="mt-1 w-full rounded-sm border border-rule bg-ink px-3 py-2 focus:border-brand-500 focus:outline-none" /></label>
            <label class="text-sm md:col-span-2"><span class="text-slate-500 dark:text-slate-400">Email domains (comma-separated)</span>
              <input v-model="domains" placeholder="company.example, company.co.example" class="mt-1 w-full rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none" /></label>
          </div>
          <p v-if="domainList.length && !gateOk" class="mt-3 text-xs text-amber-600 dark:text-amber-400">
            Your identity account's email ({{ me?.email }}) must be verified on one of these domains before the signature unlocks.
          </p>
        </section>

        <section class="rounded-sm border border-rule bg-white dark:bg-ink-2 p-6">
          <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">signatory</h2>
          <div class="mt-4 grid gap-3 md:grid-cols-2">
            <label class="text-sm"><span class="text-slate-500 dark:text-slate-400">Full legal name — typing it is your signature</span>
              <input v-model="signatoryName" autocomplete="name" class="mt-1 w-full rounded-sm border border-rule bg-ink px-3 py-2 focus:border-brand-500 focus:outline-none" /></label>
            <label class="text-sm"><span class="text-slate-500 dark:text-slate-400">Corporate email</span>
              <input v-model="signatoryEmail" class="mt-1 w-full rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none" /></label>
            <label class="text-sm"><span class="text-slate-500 dark:text-slate-400">Job title</span>
              <input v-model="signatoryTitle" class="mt-1 w-full rounded-sm border border-rule bg-ink px-3 py-2 focus:border-brand-500 focus:outline-none" /></label>
            <label class="text-sm"><span class="text-slate-500 dark:text-slate-400">GitHub username (optional — N/A allowed)</span>
              <input v-model="signatoryGithub" class="mt-1 w-full rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none" /></label>
          </div>
          <p class="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Signing authority is your representation under OCLA §4 — the
            on-domain verified mailbox is the app's integrity gate.
          </p>
        </section>

        <section class="rounded-sm border border-rule bg-white dark:bg-ink-2 p-6">
          <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">point of contact</h2>
          <div class="mt-4 grid gap-3 md:grid-cols-3">
            <label class="text-sm"><span class="text-slate-500 dark:text-slate-400">Name</span>
              <input v-model="pocName" class="mt-1 w-full rounded-sm border border-rule bg-ink px-3 py-2 focus:border-brand-500 focus:outline-none" /></label>
            <label class="text-sm"><span class="text-slate-500 dark:text-slate-400">Email <span v-if="!pocOnDomain && pocEmail" class="text-amber-600 dark:text-amber-400">(off-domain)</span></span>
              <input v-model="pocEmail" class="mt-1 w-full rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none" /></label>
            <label class="text-sm"><span class="text-slate-500 dark:text-slate-400">Phone</span>
              <input v-model="pocPhone" class="mt-1 w-full rounded-sm border border-rule bg-ink px-3 py-2 focus:border-brand-500 focus:outline-none" /></label>
          </div>
          <p class="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            The PoC manages the Schedule A and approves join requests. They receive an enrollment link bound to this email.
          </p>
        </section>

        <section class="rounded-sm border border-rule bg-white dark:bg-ink-2 p-6">
          <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Schedule A — designated employees</h2>
          <textarea
            v-model="scheduleA"
            rows="5"
            placeholder="tj-91 | Johannes Roth | johannes.roth@mtg.example | Senior Software Developer"
            class="mt-4 w-full rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none"
          ></textarea>
          <p class="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            One per line: <code>github_login | Name | email | Job title</code>. Every username is resolved
            live against GitHub — a typo here is a silently uncovered engineer, so typos refuse the signing.
          </p>
        </section>
      </div>

      <aside class="space-y-6">
        <div class="relative border-l-4 border-brand-400 bg-paper px-6 py-6 text-paper-ink">
          <div class="absolute -right-3 top-5 hidden rotate-90 lg:block">
            <span class="font-mono text-[10px] uppercase tracking-[0.25em] text-paper-ink/60">
              OCLA {{ edition?.version }} · sha256 {{ edition?.sha256 }}
            </span>
          </div>
          <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-paper-ink/60">the instrument</h2>
          <pre class="mt-3 max-h-[28rem] overflow-y-auto whitespace-pre-wrap font-serif text-[13px] leading-relaxed">{{ edition?.text }}</pre>
        </div>

        <div class="space-y-3 text-sm">
          <label class="flex items-start gap-2.5">
            <input v-model="terms" type="checkbox" class="mt-0.5 accent-[#04a9c0]" />
            <span class="leading-relaxed">I am authorized to bind this organization; we agree to the terms (edition {{ edition?.version }})</span>
          </label>
          <label class="flex items-start gap-2.5">
            <input v-model="past" type="checkbox" class="mt-0.5 accent-[#04a9c0]" />
            <span class="leading-relaxed">Includes all designated employees' previous contributions</span>
          </label>
        </div>

        <p v-if="error" class="rounded-sm border border-accent-600/40 bg-accent-600/10 px-3 py-2 text-sm text-accent-600 dark:text-accent-400" role="alert">{{ error }}</p>

        <div class="border-t border-rule pt-5">
          <div class="rounded-sm border border-rule bg-paper px-4 py-3 text-paper-ink" aria-live="polite">
            <p class="font-mono text-[10px] uppercase tracking-[0.2em] text-paper-ink/60">Signature — for {{ orgName || "the organization" }}</p>
            <p class="mt-1 font-serif text-xl italic" :class="signatoryName.trim() ? '' : 'text-paper-ink/30'">{{ signatoryName.trim() || "—" }}</p>
            <p class="mt-1 text-xs leading-relaxed text-paper-ink/60">
              By clicking below, You execute this Agreement on behalf of the organization named above.
              Your typed full legal name, bound to Your on-domain verified mailbox and Ribose ID,
              constitutes Your signature under OCLA §4.
            </p>
          </div>
          <button
            :disabled="!canSign || !gateOk || !signatoryName.trim()"
            class="mt-4 w-full rounded-sm bg-brand-500 px-4 py-3 font-semibold text-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            @click="sign"
          >
            {{ signatoryName.trim() ? `Execute as ${signatoryName.trim()}` : "Execute the OCLA" }}
          </button>
          <p class="mt-2 text-center font-mono text-[11px] text-slate-500 dark:text-slate-400">· · · sign above the line · · ·</p>
        </div>
      </aside>
    </div>
  </template>

  <template v-else-if="phase === 'done' && done">
    <div class="mx-auto max-w-lg rounded-sm border border-rule bg-white dark:bg-ink-2 p-8 text-center">
      <span class="mx-auto block h-3 w-3 rounded-[2px] bg-brand-500" aria-hidden="true"></span>
      <h1 class="mt-4 font-serif text-2xl font-semibold">Executed.</h1>
      <p class="mt-3 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        <strong class="text-ink dark:text-white">{{ done.orgSlug }}</strong> is recorded with
        {{ done.coveredCount }} designated employee{{ done.coveredCount === 1 ? "" : "s" }}.
        Send your Point of Contact this enrollment link (it expires in 14 days and is bound to their email):
      </p>
      <code class="mt-4 block break-all rounded-sm border border-rule bg-ink px-3 py-2 font-mono text-xs text-ink dark:text-white">{{ done.pocEnrollmentUrl }}</code>
      <a href="/organizations" class="mt-6 inline-block text-sm text-brand-600 hover:underline dark:text-brand-400">Your organization is now listed →</a>
    </div>
  </template>

  <p v-else class="text-slate-500 dark:text-slate-400">{{ error }}</p>
</template>

import { expect, test } from "@playwright/test";

// The golden surfaces, as a real browser sees them. No credentials:
// everything here must hold for a signed-out visitor.

test("/healthz answers the kernel honestly", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { service: string; status: string; kernel: string };
  expect(body.service).toBe("ribose-cla");
  expect(body.status).toBe("ok");
  expect(body.kernel.length).toBeGreaterThan(0);
});

test("/icla renders the instrument as a readable document", async ({ page, request }) => {
  // The edition under test is whatever this deployment compiled as
  // current (issue #123): the smoke must survive a 1.0 -> 1.1 flip
  // instead of asserting the version the example instance ships today.
  const editions = (await (await request.get("/api/editions")).json()) as { icla: { version: string; textSha256: string } };
  const { version, textSha256 } = editions.icla;
  await page.goto("/icla");
  const paper = page.locator("div.border-l-4").first();
  await expect(paper).toContainText("Individual Contributor License Agreement");
  // The counsel edition carries its identity block at the end.
  await expect(paper).toContainText("GitHub Username");
  // The provenance line under the instrument, naming the live edition
  // and its hash exactly as /editions reports them.
  await expect(paper).toContainText(`ICLA v${version} · sha256 ${textSha256}`);
});

test("/icla has no horizontal overflow at desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/icla");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("/icla is served with a CSP that keeps form-action at self for the pages", async ({ request }) => {
  const res = await request.get("/icla");
  expect(res.status()).toBe(200);
  const csp = res.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("form-action 'self'");
});

test("the edition text endpoint serves version and hash", async ({ request }) => {
  const res = await request.get("/api/editions");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { icla: { version: string; textSha256: string } };
  expect(body.icla.version).toMatch(/^\d+\.\d+$/);
  expect(body.icla.textSha256).toMatch(/^[0-9a-f]{64}$/);
  const text = await request.get(`/agreements/text/icla/${body.icla.version}`);
  expect(text.status()).toBe(200);
  const doc = (await text.json()) as { text: string; sha256: string };
  expect(doc.sha256).toBe(body.icla.textSha256);
  expect(doc.text).toContain("Individual Contributor License Agreement");
});

// P4 of issue #123 asks for zero visible stranding after a flip: the
// footer must name and link the live editions, not a baked-in version.
test("the footer names the current editions", async ({ page, request }) => {
  const editions = (await (await request.get("/api/editions")).json()) as Record<"icla" | "ocla", { version: string }>;
  await page.goto("/");
  const footer = page.locator("footer");
  for (const [kind, label] of [["icla", "Individual CLA"], ["ocla", "Organization CLA"]] as const) {
    const version = editions[kind].version;
    const link = footer.getByRole("link", { name: `${label} (edition ${version})`, exact: true });
    await expect(link).toHaveAttribute("href", `/agreements/text/${kind}/${version}`);
  }
});

test("/agreements asks for sign-in instead of pretending", async ({ page }) => {
  await page.goto("/agreements");
  await expect(page.locator("body")).toContainText(/sign/i);
});

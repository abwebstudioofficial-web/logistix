// Checks what a Gemini API key's free tier really allows the research assistant to do.
//
//   GEMINI_API_KEY=... deno run --allow-net --allow-env supabase/scripts/check-gemini.ts
//       Lists the Flash models the key can use, then asks each one grounded question and
//       reports whether Google Search grounding actually ran. Uses one request per model.
//
//   GEMINI_API_KEY=... deno run --allow-net --allow-env supabase/scripts/check-gemini.ts --until-limit gemini-2.5-flash
//       Keeps asking grounded questions until Google refuses, then prints the per-minute and
//       per-day limits from Google's own error details. This USES UP the day's free quota for
//       that model, so the assistant can't use it again until the daily reset.

const API = Deno.env.get("GEMINI_API_BASE") ?? "https://generativelanguage.googleapis.com/v1beta";
const KEY = Deno.env.get("GEMINI_API_KEY");
if (!KEY) {
  console.error("Set GEMINI_API_KEY first.");
  Deno.exit(1);
}
const QUESTION = "What is the current PSO high-speed diesel price per litre in Pakistan? Answer in one sentence.";

type Result = { ok: true; body: any; ms: number } | { ok: false; status: number; error: any; ms: number };

async function ask(model: string): Promise<Result> {
  const started = Date.now();
  const res = await fetch(`${API}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY! },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: QUESTION }] }], tools: [{ google_search: {} }] }),
  });
  const body = await res.json().catch(() => ({}));
  const ms = Date.now() - started;
  return res.ok ? { ok: true, body, ms } : { ok: false, status: res.status, error: body.error ?? body, ms };
}

/** The quota facts Google puts in a 429: which limit, its value, and how long to wait. */
function quotaInfo(error: any) {
  const details: any[] = error?.details ?? [];
  const violations = details.flatMap((d) => d.violations ?? []);
  const retry = details.find((d) => d.retryDelay)?.retryDelay ?? null;
  return { violations: violations.map((v) => ({ quotaId: v.quotaId, quotaValue: v.quotaValue, quotaMetric: v.quotaMetric })), retry };
}

function describe(model: string, r: Result) {
  if (!r.ok) {
    console.log(`  ${model}: HTTP ${r.status} ${r.error?.status ?? ""} - ${r.error?.message ?? ""}`);
    const q = quotaInfo(r.error);
    for (const v of q.violations) console.log(`    quota: ${v.quotaId} = ${v.quotaValue}`);
    if (q.retry) console.log(`    retry after: ${q.retry}`);
    return;
  }
  const c = r.body.candidates?.[0];
  const g = c?.groundingMetadata;
  const text = (c?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
  console.log(`  ${model}: OK in ${(r.ms / 1000).toFixed(1)}s`);
  console.log(`    grounding ran: ${g?.webSearchQueries?.length ? "YES" : "NO"}` +
    (g?.webSearchQueries?.length ? `  queries: ${JSON.stringify(g.webSearchQueries)}` : ""));
  console.log(`    sources: ${(g?.groundingChunks ?? []).map((x: any) => x.web?.title).filter(Boolean).join(", ") || "none"}`);
  console.log(`    search suggestions returned: ${g?.searchEntryPoint?.renderedContent ? "yes" : "no"}`);
  console.log(`    answer: ${text.slice(0, 200)}`);
  console.log(`    tokens: ${JSON.stringify(r.body.usageMetadata ?? {})}`);
}

async function listFlashModels(): Promise<string[]> {
  const res = await fetch(`${API}/models?pageSize=1000`, { headers: { "x-goog-api-key": KEY! } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(`Listing models failed: HTTP ${res.status} ${body.error?.status ?? ""} - ${body.error?.message ?? ""}`);
    Deno.exit(1);
  }
  return (body.models ?? [])
    .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m: any) => String(m.name).replace(/^models\//, ""))
    .filter((name: string) => /flash/.test(name) && !/(tts|image|audio|live|embedding|preview-\d{2}-\d{2})/.test(name));
}

async function untilLimit(model: string, max: number) {
  console.log(`Asking ${model} grounded questions until Google refuses (at most ${max}). This uses up today's free quota.`);
  let ok = 0, grounded = 0;
  const minuteLimits = new Set<string>();
  for (let i = 0; i < max; i++) {
    const r = await ask(model);
    if (r.ok) {
      ok++;
      if (r.body.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length) grounded++;
      if (ok % 10 === 0) console.log(`  ${ok} answered so far (${grounded} grounded)`);
      continue;
    }
    const q = quotaInfo(r.error);
    const daily = q.violations.filter((v) => /PerDay/i.test(v.quotaId ?? ""));
    if (r.status === 429 && !daily.length) {
      q.violations.forEach((v) => minuteLimits.add(`${v.quotaId} = ${v.quotaValue}`));
      const wait = Math.ceil(parseFloat(q.retry ?? "60") || 60) + 1;
      console.log(`  per-minute limit after ${ok} answers, waiting ${wait}s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      i--; // a refused request doesn't count toward the daily total
      continue;
    }
    console.log(`\nStopped after ${ok} answered requests (${grounded} of them grounded).`);
    describe(model, r);
    for (const m of minuteLimits) console.log(`    per-minute quota seen earlier: ${m}`);
    return;
  }
  console.log(`\nReached the cap of ${max} answered requests without hitting a daily limit (${grounded} grounded).`);
}

const args = Deno.args;
const limitAt = args.indexOf("--until-limit");
if (limitAt >= 0) {
  const maxAt = args.indexOf("--max");
  await untilLimit(args[limitAt + 1] ?? "gemini-2.5-flash", maxAt >= 0 ? Number(args[maxAt + 1]) : 1500);
} else {
  const models = await listFlashModels();
  console.log(`Flash models this key can use: ${models.join(", ") || "none"}\n`);
  const toTry = [...new Set(["gemini-2.5-flash", "gemini-2.5-flash-lite", ...models.filter((m) => /^gemini-3/.test(m))])];
  console.log(`Asking one grounded question on: ${toTry.join(", ")}`);
  for (const model of toTry) describe(model, await ask(model));
}

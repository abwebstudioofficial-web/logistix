// Everything the research assistant needs from Gemini: the prompt, the request, error
// explanations, and turning the streamed reply into panel events. Used by index.ts.

const API_BASE = Deno.env.get("GEMINI_API_BASE") ?? "https://generativelanguage.googleapis.com/v1beta";
const MODEL_OVERRIDE = Deno.env.get("GEMINI_MODEL") || "";
// Google retires models regularly, so the function asks which models the key can use and
// tries them in this order. Each model has its own free daily limit, so when one is used
// up (or missing, or not free on this key) the question moves on to the next.
const PREFERRED_FLASH = ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3-flash"];
const PREFERRED_LITE = ["gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.1-flash-lite"];
const MAX_MODEL_TRIES = 4;
const MODEL_LIST_TTL_MS = 60 * 60 * 1000;
// Supabase stops a function after 150 s on the free plan; leave room to report back.
export const TIME_LIMIT_MS = 110_000;
const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 12000;

export const SECTIONS = [
  { view: "dashboard", title: "Dashboard", about: "overview of operations at a glance" },
  { view: "orders_domestic", title: "Domestic Orders", about: "domestic shipment orders by category (Finished Goods, Wrapping Materials, WM Domestic Karachi)" },
  { view: "orders_import", title: "Import Orders", about: "import container shipment orders" },
  { view: "orders_export", title: "Export Orders", about: "export container shipment orders" },
  { view: "tracking_import", title: "Import Tracking", about: "stage-by-stage tracking of import containers" },
  { view: "tracking_domestic", title: "Domestic Tracking", about: "stage-by-stage tracking of domestic shipments" },
  { view: "tracking_export", title: "Export Tracking", about: "stage-by-stage tracking of export containers" },
  { view: "contracts", title: "Contracts", about: "agreed freight rates per customer" },
  { view: "invoices", title: "Invoices", about: "generate, track and manage invoices" },
  { view: "fuel_management", title: "Fuel Management", about: "fuel usage by rented vehicle, fuel prices on file, and fuel card swaps" },
  { view: "customers", title: "Customers", about: "client accounts" },
  { view: "senders", title: "Senders", about: "companies and warehouses shipments are sent from" },
  { view: "transporters", title: "Transporters", about: "trucking companies contracted for haulage" },
  { view: "bill_checker", title: "Transporter Bills", about: "transporter billing details and approved charges per container" },
  { view: "analytics", title: "Analytics", about: "performance insights across operations" },
  { view: "activity_log", title: "Activity Log", about: "every change across every order: who did what, and when" },
  { view: "order_history", title: "Order History", about: "every completed order, kept permanently" },
  { view: "settings", title: "Settings", about: "which table columns show in this browser" },
  { view: "users", title: "Manage Users", about: "assign roles to team accounts" },
];

// Gemini 2.5 models can't use Google Search and custom functions in the same request, so
// the reply asks to open a section with a marker line instead. That also keeps every
// question to a single request against the free daily limit.
export const OPEN_MARKER = /\[\[open:([a-z_]+)(:now)?\]\]/g;

export function systemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  const sections = SECTIONS.map((s) => `- ${s.view}: ${s.title} (${s.about})`).join("\n");
  return `You are the research assistant inside Logistix, the transport ERP of a logistics \
company in Pakistan that runs domestic, import and export container and truck movements \
(amounts are in PKR). You appear in a chat panel for the company's admins and help with two \
things:

1. Researching anything related to transportation and logistics with Google Search: diesel \
and fuel prices (PSO, OGRA notifications), freight and container rates, shipping lines and \
vessel schedules, Karachi Port and Port Qasim terminals, customs and FBR/WeBOC procedures, NHA \
rules such as axle-load limits and tolls, motorway and GT Road conditions, weather and \
disruptions, regulations, and industry news in Pakistan and worldwide.
2. Finding their way around Logistix by opening the right section.

How to research:
- Search for current information rather than relying on memory, and prefer primary sources: \
regulators (OGRA, FBR, NHA), port authorities, shipping lines and official notifications.
- Skip searching when the user only wants to open a section or asks how to use Logistix.

Opening sections:
- When one section is where the user wants to go, or where they would act on your answer, end \
your reply with a final line containing only [[open:KEY]], using a key from the list below. \
Use [[open:KEY:now]] instead when the user asked to be taken there, e.g. "open invoices" or \
"take me to fuel management".
- Use at most one such line per reply, and never mention it in the text.
- You cannot look up individual orders, invoices or other records. If asked about one, open the \
section where they can find it and say so.

How to answer:
- The chat panel is narrow. Open with the answer in a sentence or two, then key details as a \
short list. Stay under about 250 words unless the user asks for more depth.
- Say plainly when sources disagree or information may be out of date. Do not guess.
- Stay focused on transportation, logistics and using Logistix. If asked about something \
unrelated, say briefly that you are set up for transportation and logistics research.

Logistix sections:
${sections}

Today's date is ${today}.`;
}

export type Send = (event: string, data: Record<string, unknown>) => void;
export type Turn = { role: "user" | "assistant"; text: string };
export type Content = { role: "user" | "model"; parts: { text: string }[] };

/** A failure with a message that is safe to show the user, and a code the panel can use. */
export class UserError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// -- talking to Gemini ------------------------------------------------------------------

/** Explains a failed Gemini API response in terms the user can act on. */
export function explainGeminiError(status: number, body: unknown, model = "the model"): UserError {
  const error = (body as { error?: { message?: string; status?: string; details?: unknown[] } })?.error ?? {};
  const message = String(error.message ?? "");
  const details = Array.isArray(error.details) ? error.details as Record<string, unknown>[] : [];
  const reasons = details.map((d) => String(d.reason ?? ""));
  const violations = details.flatMap((d) => Array.isArray(d.violations) ? d.violations as Record<string, unknown>[] : []);
  const quotaIds = violations.map((v) => String(v.quotaId ?? ""));
  const retryDelay = details.map((d) => String(d.retryDelay ?? "")).find((r) => r) ?? "";

  if (reasons.includes("API_KEY_INVALID") || /API key not valid/i.test(message)) {
    return new UserError("invalid_key", "The Gemini API key is invalid. Check the GEMINI_API_KEY secret in Supabase (Edge Functions → Secrets).");
  }
  if (status === 403) {
    const why = /leaked/i.test(message) ? "Google has blocked it as leaked; create a new key in Google AI Studio" : "check that it's a Gemini API key from Google AI Studio";
    return new UserError("invalid_key", `Google rejected the Gemini API key: ${why}, then update the GEMINI_API_KEY secret in Supabase.`);
  }
  if (status === 429) {
    if (violations.some((v) => String(v.quotaValue ?? "") === "0") || /limit: 0\b/.test(message)) {
      return new UserError("not_free", `The Gemini model "${model}" isn't included in this key's free tier.`);
    }
    if (quotaIds.some((id) => /PerDay/i.test(id)) || /per ?day|daily/i.test(message)) {
      return new UserError(
        "daily_limit",
        "Today's free Gemini limit has been reached. It resets at midnight Pacific time (about 12:00–1:00 pm in Pakistan). Please try again then.",
      );
    }
    const seconds = Math.ceil(parseFloat(retryDelay) || 60);
    return new UserError("minute_limit", `Too many questions in the last minute for the free Gemini limit. Please wait about ${seconds} seconds and try again.`);
  }
  if (status === 400 && /location is not supported/i.test(message)) {
    return new UserError("region", "Google's Gemini API isn't available from the region this Supabase function runs in.");
  }
  if (status === 404 || /no longer available|is not found for API version/i.test(message)) {
    return new UserError("model_missing", `The Gemini model "${model}" isn't available to this key.`);
  }
  if (status >= 500) {
    return new UserError("busy", "Gemini is busy or having a problem right now. Please try again in a moment.");
  }
  return new UserError("error", `Gemini returned an error (${status}${error.status ? ` ${error.status}` : ""}). Please try again.`);
}

async function streamGemini(model: string, key: string, contents: Content[], signal: AbortSignal): Promise<Response> {
  const res = await fetch(`${API_BASE}/models/${model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents,
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 8192 },
    }),
    signal,
  });
  if (!res.ok) throw logged(model, res.status, await res.json().catch(() => ({})));
  return res;
}

/** Logs Google's error for the Supabase function logs, and returns the user-facing version. */
function logged(model: string, status: number, body: unknown): UserError {
  const error = (body as { error?: Record<string, unknown> })?.error ?? {};
  console.warn(`Gemini ${model}: HTTP ${status} ${error.status ?? ""} ${String(error.message ?? "").slice(0, 300)} ${JSON.stringify(error.details ?? []).slice(0, 600)}`);
  return explainGeminiError(status, body, model);
}

let modelList: { at: number; names: string[] } | null = null;
// Models that refused as missing or not free, skipped until the time stored (per worker).
const unusable = new Map<string, number>();

/** The models this key can generate content with, cached for an hour per worker. */
async function availableModels(key: string, signal: AbortSignal): Promise<string[]> {
  if (modelList && Date.now() - modelList.at < MODEL_LIST_TTL_MS) return modelList.names;
  const res = await fetch(`${API_BASE}/models?pageSize=1000`, { headers: { "x-goog-api-key": key }, signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw logged("model list", res.status, body);
  const names = ((body as { models?: { name?: string; supportedGenerationMethods?: string[] }[] }).models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => String(m.name).replace(/^models\//, ""));
  modelList = { at: Date.now(), names };
  return names;
}

function version(name: string): number[] {
  return (name.match(/^gemini-([\d.]+)-/)?.[1] ?? "0").split(".").map(Number);
}
function newestFirst(a: string, b: string): number {
  const [x, y] = [version(a), version(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/** Models to try, best first: GEMINI_MODEL if set, then Flash, then Flash-Lite models the key has. */
export function chooseModels(available: string[], override = MODEL_OVERRIDE): string[] {
  const has = new Set(available);
  const stable = (re: RegExp, preferred: string[]) => [
    ...preferred.filter((m) => has.has(m)),
    ...available.filter((m) => re.test(m) && !preferred.includes(m)).sort(newestFirst),
  ];
  const flash = stable(/^gemini-\d+(\.\d+)?-flash$/, PREFERRED_FLASH);
  const lite = stable(/^gemini-\d+(\.\d+)?-flash-lite$/, PREFERRED_LITE);
  return [...new Set([...(override ? [override] : []), ...flash, ...lite])];
}

// Worth moving on to the next model for these; anything else (bad key, safety, overload) isn't.
const TRY_NEXT_MODEL = new Set(["model_missing", "not_free", "daily_limit"]);

/** Starts the reply on the first model that accepts it. */
async function openStream(key: string, contents: Content[], send: Send, signal: AbortSignal) {
  const now = Date.now();
  const candidates = chooseModels(await availableModels(key, signal))
    .filter((m) => (unusable.get(m) ?? 0) < now)
    .slice(0, MAX_MODEL_TRIES);
  if (!candidates.length) throw new UserError("model_missing", "This Gemini key has no Gemini Flash model available. Check the key in Google AI Studio.");
  let daily: UserError | null = null;
  let last: UserError | null = null;
  for (const model of candidates) {
    try {
      return { model, res: await streamGemini(model, key, contents, signal) };
    } catch (err) {
      if (!(err instanceof UserError) || !TRY_NEXT_MODEL.has(err.code)) throw err;
      if (err.code === "model_missing" || err.code === "not_free") unusable.set(model, Date.now() + MODEL_LIST_TTL_MS);
      if (err.code === "daily_limit") daily = err;
      last = err;
      send("status", { kind: "fallback", text: "Trying another Gemini model…" });
    }
  }
  // Every model refused. If any hit its daily limit, that's what the user needs to know.
  if (daily) throw daily;
  if (candidates.length > 1) {
    throw new UserError(last!.code, "None of the Gemini Flash models this key can use are available on its free tier right now. Type /check in the panel for details.");
  }
  throw last!;
}

/**
 * The /check command: which Flash models this key can use, and whether Google Search
 * grounding really runs on each. Uses one request per model tested (at most three).
 */
export async function diagnose(key: string, send: Send, signal: AbortSignal) {
  send("status", { kind: "thinking", text: "Checking which Gemini models this key can use…" });
  modelList = null;
  unusable.clear();
  const available = await availableModels(key, signal);
  const flashModels = chooseModels(available, "");
  const candidates = chooseModels(available).slice(0, 3);
  const lines = [
    `**Gemini check** (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`,
    "",
    `Flash models this key can use: ${flashModels.join(", ") || "none"}`,
    MODEL_OVERRIDE ? `GEMINI_MODEL secret: ${MODEL_OVERRIDE}` : "GEMINI_MODEL secret: not set",
    "",
  ];
  const report: Record<string, unknown>[] = [];
  for (const model of candidates) {
    send("status", { kind: "search", text: `Testing ${model} with Google Search…` });
    const started = Date.now();
    const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "What is the latest PSO petrol price in Pakistan? Answer in one sentence." }] }],
        tools: [{ google_search: {} }],
      }),
      signal,
    });
    const body = await res.json().catch(() => ({}));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (res.ok) {
      const grounding = body.candidates?.[0]?.groundingMetadata;
      const searches = grounding?.webSearchQueries?.length ?? 0;
      const found = grounding?.groundingChunks?.length ?? 0;
      lines.push(`- **${model}**: works (${seconds}s). Google Search ${searches ? `ran: ${searches} searches, ${found} sources.` : "did not run."}`);
      report.push({ model, ok: true, searches, sources: found, seconds });
    } else {
      const err = explainGeminiError(res.status, body, model);
      const limits = (body.error?.details ?? []).flatMap((d: { violations?: { quotaId?: string; quotaValue?: string }[] }) => d.violations ?? [])
        .map((v: { quotaId?: string; quotaValue?: string }) => `${v.quotaId} = ${v.quotaValue}`);
      lines.push(`- **${model}**: HTTP ${res.status}. ${err.message}${limits.length ? ` Limits reported by Google: ${limits.join("; ")}.` : ""}`);
      report.push({ model, ok: false, status: res.status, code: err.code, limits });
    }
  }
  lines.push("", "Questions use the first model above that works.");
  console.log(`research-agent /check ${JSON.stringify(report)}`);
  return { answer: lines.join("\n"), sources: [], navigate: null, search_suggestions: null, truncated: false, model: candidates[0] ?? null };
}

/** Hides [[open:...]] markers while the reply streams, including markers split across chunks. */
export class MarkerFilter {
  private held = "";
  push(delta: string): string {
    const text = this.held + delta;
    const start = text.lastIndexOf("[[");
    const unfinished = start >= 0 && !text.includes("]]", start) && text.length - start < 40;
    const cut = unfinished ? start : text.endsWith("[") ? text.length - 1 : text.length;
    this.held = text.slice(cut);
    return text.slice(0, cut).replace(OPEN_MARKER, "");
  }
  flush(): string {
    const rest = this.held.replace(OPEN_MARKER, "");
    this.held = "";
    return rest;
  }
}

export async function answer(key: string, contents: Content[], send: Send, signal: AbortSignal) {
  send("status", { kind: "thinking", text: "Thinking…" });
  const { model, res } = await openStream(key, contents, send, signal);

  const filter = new MarkerFilter();
  const sources = new Map<string, { url: string; title: string | null }>();
  let text = "";
  let finishReason = "";
  let blockReason = "";
  let suggestions: string | null = null;
  const queries = new Set<string>();

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    let chunk;
    try {
      chunk = JSON.parse(line.slice(5));
    } catch {
      return; // not a complete event; Gemini sends one JSON object per data line
    }
    if (chunk.error) throw logged(model, chunk.error.code ?? 500, chunk);
    if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
    const candidate = chunk.candidates?.[0];
    if (!candidate) return;
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === "string" && !part.thought) {
        text += part.text;
        const visible = filter.push(part.text);
        if (visible) send("text", { delta: visible });
      }
    }
    const grounding = candidate.groundingMetadata;
    if (grounding) {
      const fresh = (grounding.webSearchQueries ?? []).filter((q: string) => !queries.has(q));
      fresh.forEach((q: string) => queries.add(q));
      if (fresh.length) send("status", { kind: "search", text: `Searched: ${fresh.join("; ")}` });
      for (const c of grounding.groundingChunks ?? []) {
        if (c.web?.uri && !sources.has(c.web.uri)) sources.set(c.web.uri, { url: c.web.uri, title: c.web.title ?? null });
      }
      if (grounding.searchEntryPoint?.renderedContent) suggestions = grounding.searchEntryPoint.renderedContent;
    }
    if (candidate.finishReason) finishReason = candidate.finishReason;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach(handle);
  }
  handle(buffer);
  const tail = filter.flush();
  if (tail) send("text", { delta: tail });

  if (blockReason || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(finishReason)) {
    throw new UserError("blocked", "Gemini declined to answer that. Try rephrasing the question.");
  }

  const markers = [...text.matchAll(OPEN_MARKER)];
  const last = markers.at(-1);
  const section = last ? SECTIONS.find((s) => s.view === last[1]) : undefined;
  return {
    answer: text.replace(OPEN_MARKER, "").trim(),
    sources: [...sources.values()],
    navigate: section ? { view: section.view, title: section.title, go_now: Boolean(last![2]) } : null,
    search_suggestions: suggestions,
    truncated: finishReason === "MAX_TOKENS",
    model,
  };
}

/** Validates the request body and builds the conversation to send. */
export function parseBody(body: unknown): Content[] | string {
  const { message, history } = (body ?? {}) as { message?: unknown; history?: unknown };
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_CHARS) {
    return `Send a message of 1 to ${MAX_MESSAGE_CHARS} characters.`;
  }
  const turns: Turn[] = [];
  if (history !== undefined) {
    if (!Array.isArray(history)) return "history must be a list.";
    for (const turn of history.slice(-MAX_HISTORY_TURNS)) {
      const { role, text } = (turn ?? {}) as { role?: unknown; text?: unknown };
      if ((role !== "user" && role !== "assistant") || typeof text !== "string" || !text.trim()) return "Invalid history entry.";
      turns.push({ role, text: text.slice(0, MAX_HISTORY_CHARS) });
    }
  }
  turns.push({ role: "user", text: message.trim() });

  // Gemini expects the conversation to start with the user and alternate turns.
  const contents: Content[] = [];
  for (const turn of turns) {
    const role = turn.role === "user" ? "user" : "model";
    const last = contents.at(-1);
    if (!last && role === "model") continue;
    if (last && last.role === role) last.parts[0].text += `\n\n${turn.text}`;
    else contents.push({ role, parts: [{ text: turn.text }] });
  }
  return contents;
}

// The research assistant's brain: a free chat model on Groq (any OpenAI-compatible API works)
// that can search the web with Tavily and open Logistix sections. Used by index.ts.
//
// Secrets (Supabase dashboard > Edge Functions > Secrets):
//   GROQ_API_KEY    required, from console.groq.com (free, no card)
//   TAVILY_API_KEY  required, from app.tavily.com (free: 1,000 searches a month)
//   LLM_MODEL       optional, defaults to openai/gpt-oss-120b
//   LLM_BASE_URL    optional, to use another OpenAI-compatible provider instead of Groq
//                   (its key then goes in GROQ_API_KEY, or in LLM_API_KEY)

const LLM_BASE = (Deno.env.get("LLM_BASE_URL") || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const TAVILY_BASE = Deno.env.get("TAVILY_API_BASE") || "https://api.tavily.com";
const PRIMARY_MODEL = Deno.env.get("LLM_MODEL") || "openai/gpt-oss-120b";
// Each Groq model has its own free daily limit, so when the main one's is used up (or it's
// been retired), the question moves on to this one.
const BACKUP_MODEL = "openai/gpt-oss-20b";
// Supabase stops a function after 150 s on the free plan; leave room to report back.
export const TIME_LIMIT_MS = 110_000;
const MAX_STEPS = 6;
const MAX_SEARCHES = 3; // per question; each search uses one of Tavily's free monthly credits
const MAX_MESSAGE_CHARS = 4000;
// Groq's free plan allows about 8,000 tokens a minute, and every step of a question resends the
// whole conversation, so earlier turns and search results are kept short.
const MAX_HISTORY_TURNS = 12;
const MAX_TURN_CHARS = 2000;
const MAX_HISTORY_CHARS = 6000; // all earlier turns together
const MAX_RESULT_CHARS = 700; // text kept from each search result
const MAX_WAIT_S = 20; // wait this long at most for the per-minute limit before giving up

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

export function systemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  const sections = SECTIONS.map((s) => `- ${s.view}: ${s.title} (${s.about})`).join("\n");
  return `You are the research assistant inside Logistix, the transport ERP of a logistics \
company in Pakistan that runs domestic, import and export container and truck movements \
(amounts are in PKR). You appear in a chat panel for the company's admins and help with two \
things:

1. Researching anything related to transportation and logistics on the web: diesel and fuel \
prices (PSO, OGRA notifications), freight and container rates, shipping lines and vessel \
schedules, Karachi Port and Port Qasim terminals, customs and FBR/WeBOC procedures, NHA rules \
such as axle-load limits and tolls, motorway and GT Road conditions, weather and disruptions, \
regulations, and industry news in Pakistan and worldwide.
2. Finding their way around Logistix by opening the right section with open_section.

How to research:
- Use web_search for anything current (prices, news, schedules, rules that may have changed). \
Do not answer those from memory. Use topic "news" for recent events.
- You have at most ${MAX_SEARCHES} searches per question, so make each query specific.
- Prefer primary sources: regulators (OGRA, FBR, NHA), port authorities, shipping lines and \
official notifications.
- Skip searching when the user only wants to open a section or asks how to use Logistix.

Opening sections:
- Call open_section when the user asks to go to a section, or when one section is clearly \
where they would act on your answer. Set go_now to true only when they asked to be taken there.
- You cannot look up individual orders, invoices or other records. If asked about one, open the \
section where they can find it and say so.

How to answer:
- The chat panel is narrow. Open with the answer in a sentence or two, then key details as a \
short list. Stay under about 250 words unless the user asks for more depth.
- Cite sources inline as Markdown links, using only URLs from your search results.
- Say plainly when sources disagree or information may be out of date. Do not guess.
- Stay focused on transportation, logistics and using Logistix. If asked about something \
unrelated, say briefly that you are set up for transportation and logistics research.

Logistix sections:
${sections}

Today's date is ${today}.`;
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current information. Call this for prices, news, schedules, regulations or anything " +
        "that may have changed recently. Returns the top results with their text.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A specific search query, e.g. \"PSO high speed diesel price September 2026\"." },
          topic: { type: "string", enum: ["general", "news"], description: "\"news\" for recent events and announcements." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_section",
      description:
        "Open a section of Logistix for the user. Call it when the user asks to go to a section, or when one " +
        "section is clearly where they would act on your answer. At most once per reply.",
      parameters: {
        type: "object",
        properties: {
          view: { type: "string", enum: SECTIONS.map((s) => s.view), description: "Key of the section to open." },
          go_now: { type: "boolean", description: "true only if the user asked to be taken there; false shows a button." },
        },
        required: ["view", "go_now"],
        additionalProperties: false,
      },
    },
  },
];

export type Send = (event: string, data: Record<string, unknown>) => void;
export type Turn = { role: "user" | "assistant"; text: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type Source = { url: string; title: string | null };
type Destination = { view: string; title: string; go_now: boolean };

/** A failure with a message that is safe to show the user, and a code the panel can use. */
export class UserError extends Error {
  /** For per-minute limits: how many seconds until another request is allowed, if known. */
  retryAfter: number | null = null;
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type Keys = { llm: string; tavily: string };

// -- errors ---------------------------------------------------------------------------

/** Seconds until the limit allows another request, from the retry-after header or "try again in 1m26.4s". */
function waitSeconds(res: Response, message: string): number | null {
  const header = Number(res.headers.get("retry-after"));
  if (header > 0) return Math.ceil(header);
  const m = message.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return Math.ceil(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}

function waitText(seconds: number | null): string {
  if (seconds === null) return "a minute";
  if (seconds < 90) return `about ${seconds} seconds`;
  const h = Math.floor(seconds / 3600), m = Math.ceil((seconds % 3600) / 60);
  return h ? `about ${h} h ${m} min` : `about ${m} minutes`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/** Explains a failed chat-model (Groq) response in terms the user can act on. */
export function explainLlmError(res: Response, body: unknown, model: string): UserError {
  const error = (body as { error?: { message?: string; code?: string; type?: string } })?.error ?? {};
  const message = String(error.message ?? "");
  const code = String(error.code ?? "");
  if (res.status === 401 || code === "invalid_api_key") {
    return new UserError("invalid_key", "The Groq API key is invalid. Check the GROQ_API_KEY secret in Supabase (Edge Functions → Secrets).");
  }
  if (res.status === 403) {
    return new UserError("invalid_key", `Groq refused the request: ${message || "access denied"}. Check the key's account at console.groq.com.`);
  }
  if (res.status === 404 || code === "model_not_found" || code === "model_decommissioned") {
    return new UserError("model_missing", `The model "${model}" isn't available on Groq any more.`);
  }
  if (res.status === 429) {
    const wait = waitSeconds(res, message);
    if (/per day|\(RPD\)|\(TPD\)/i.test(message)) {
      return new UserError("daily_limit", `Today's free Groq limit for the assistant has been reached. Please try again in ${waitText(wait)}.`);
    }
    const err = new UserError("minute_limit", `Too many questions in the last minute for the free Groq limit. Please wait ${waitText(wait)} and try again.`);
    err.retryAfter = wait;
    return err;
  }
  if (res.status === 413 && /per minute|\(TPM\)/i.test(message)) {
    return new UserError("too_long", "This question needs more text than Groq's free per-minute limit allows. Click \"New chat\" or ask a narrower question.");
  }
  if (res.status === 413 || code === "context_length_exceeded") {
    return new UserError("too_long", "This conversation has grown too long. Click \"New chat\" and ask again.");
  }
  if (code === "tool_use_failed") return new UserError("tool_failed", "The model stumbled while using its tools.");
  if (res.status >= 500) return new UserError("busy", "Groq is busy or having a problem right now. Please try again in a moment.");
  return new UserError("error", `Groq returned an error (${res.status}${code ? ` ${code}` : ""}). Please try again.`);
}

/** Explains a failed Tavily search response. */
export function explainSearchError(res: Response, body: unknown): UserError {
  const detail = (body as { detail?: { error?: string } | string })?.detail;
  const message = typeof detail === "string" ? detail : String(detail?.error ?? "");
  if (res.status === 401 || res.status === 403) {
    return new UserError("invalid_key", "The Tavily API key is invalid. Check the TAVILY_API_KEY secret in Supabase (Edge Functions → Secrets).");
  }
  if (res.status === 432 || res.status === 433 || /usage limit|plan limit|credits/i.test(message)) {
    return new UserError("search_limit", "This month's free web searches (1,000 Tavily credits) are used up. They reset on the 1st of next month.");
  }
  if (res.status === 429) return new UserError("minute_limit", "Too many web searches in the last minute. Please wait a minute and try again.");
  return new UserError("busy", `Web search failed (${res.status}). Please try again in a moment.`);
}

function log(what: string, status: number, body: unknown) {
  console.warn(`${what}: HTTP ${status} ${JSON.stringify(body).slice(0, 600)}`);
}

// -- the two services -----------------------------------------------------------------

async function chat(keys: Keys, model: string, messages: Message[], signal: AbortSignal) {
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys.llm}` },
    // Low reasoning effort keeps each question well inside the free per-minute token limit.
    body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: "auto", reasoning_effort: "low", max_completion_tokens: 2048 }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    log(`LLM ${model}`, res.status, body);
    throw explainLlmError(res, body, model);
  }
  const choice = (body as { choices?: { message?: Message & { tool_calls?: ToolCall[] }; finish_reason?: string }[] }).choices?.[0];
  if (!choice?.message) throw new UserError("error", "Groq sent back an empty reply. Please try again.");
  return { message: choice.message as { content: string | null; tool_calls?: ToolCall[] }, finish: choice.finish_reason ?? "" };
}

async function search(keys: Keys, query: string, topic: string, signal: AbortSignal) {
  const res = await fetch(`${TAVILY_BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys.tavily}` },
    body: JSON.stringify({ query, topic: topic === "news" ? "news" : "general", search_depth: "basic", max_results: 5 }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    log("Tavily search", res.status, body);
    throw explainSearchError(res, body);
  }
  return ((body as { results?: { title?: string; url?: string; content?: string; published_date?: string }[] }).results ?? [])
    .filter((r) => r.url)
    .map((r) => ({ title: r.title ?? null, url: r.url!, content: String(r.content ?? "").slice(0, MAX_RESULT_CHARS), published: r.published_date ?? null }));
}

// -- the agent loop -------------------------------------------------------------------

function parseArgs(call: ToolCall): Record<string, unknown> | null {
  try {
    const args = JSON.parse(call.function.arguments || "{}");
    return args && typeof args === "object" && !Array.isArray(args) ? args : null;
  } catch {
    return null;
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export async function answer(keys: Keys, history: Message[], send: Send, signal: AbortSignal) {
  send("status", { kind: "thinking", text: "Thinking…" });
  const messages: Message[] = [{ role: "system", content: systemPrompt() }, ...history];
  const sources = new Map<string, Source>();
  let destination: Destination | null = null;
  let searches = 0;
  let model = PRIMARY_MODEL;
  let toolRetries = 0;
  let waits = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    let reply;
    try {
      reply = await chat(keys, model, messages, signal);
    } catch (err) {
      if (err instanceof UserError && ["daily_limit", "model_missing"].includes(err.code) && model !== BACKUP_MODEL) {
        model = BACKUP_MODEL;
        send("status", { kind: "fallback", text: "Switching to a backup model…" });
        step--;
        continue;
      }
      if (err instanceof UserError && err.code === "minute_limit" && err.retryAfter !== null && err.retryAfter <= MAX_WAIT_S && waits++ < 2) {
        send("status", { kind: "waiting", text: `Waiting ${err.retryAfter} s for the free per-minute limit…` });
        await sleep(err.retryAfter * 1000 + 250, signal);
        step--;
        continue;
      }
      if (err instanceof UserError && err.code === "tool_failed" && toolRetries++ < 1) {
        step--;
        continue;
      }
      if (err instanceof UserError && err.code === "tool_failed") {
        throw new UserError("error", "The assistant couldn't finish that. Try rephrasing the question.");
      }
      throw err;
    }

    const calls = reply.message.tool_calls ?? [];
    if (!calls.length) {
      const text = (reply.message.content ?? "").trim();
      if (text) send("text", { delta: text });
      // List the pages the answer links to; if it links none, list everything that was read.
      const all = [...sources.values()];
      const cited = all.filter((s) => text.includes(s.url));
      return {
        answer: text,
        sources: cited.length ? cited : all,
        navigate: destination,
        search_suggestions: null,
        truncated: reply.finish === "length",
        model,
      };
    }

    messages.push({ role: "assistant", content: reply.message.content ?? "", tool_calls: calls });
    for (const call of calls) {
      const args = parseArgs(call);
      let result: string;
      if (!args) {
        result = JSON.stringify({ error: "Arguments were not valid JSON." });
      } else if (call.function.name === "web_search") {
        const query = typeof args.query === "string" ? args.query.trim().slice(0, 300) : "";
        if (!query) {
          result = JSON.stringify({ error: "query is required." });
        } else if (searches >= MAX_SEARCHES) {
          result = JSON.stringify({ error: `Search limit for this question reached (${MAX_SEARCHES}). Answer with what you have.` });
        } else {
          searches++;
          send("status", { kind: "search", text: `Searching the web: ${query}` });
          const results = await search(keys, query, String(args.topic ?? ""), signal);
          for (const r of results) if (!sources.has(r.url)) sources.set(r.url, { url: r.url, title: r.title ?? hostname(r.url) });
          result = JSON.stringify(results.length ? results : { results: [], note: "No results. Try a different query." });
        }
      } else if (call.function.name === "open_section") {
        const section = SECTIONS.find((s) => s.view === args.view);
        if (!section || typeof args.go_now !== "boolean") {
          result = JSON.stringify({ error: "Use a section key from the list and a true/false go_now." });
        } else {
          destination = { view: section.view, title: section.title, go_now: args.go_now };
          send("status", { kind: "navigate", text: `Opening ${section.title}…` });
          result = args.go_now
            ? `${section.title} will open when your reply finishes.`
            : `The user will see a button to ${section.title} under your reply.`;
        }
      } else {
        result = JSON.stringify({ error: `Unknown tool ${call.function.name}.` });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  throw new UserError("error", "The assistant took too many steps without an answer. Try a narrower question.");
}

// -- /check -------------------------------------------------------------------------------

/**
 * The /check command: tests both keys and reports the real free limits the services send
 * back. Uses one small chat request per model and one Tavily search credit.
 */
export async function diagnose(keys: Keys, send: Send, signal: AbortSignal) {
  send("status", { kind: "thinking", text: "Checking the Groq and Tavily keys…" });
  const lines = [`**Research assistant check** (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`, ""];
  const report: Record<string, unknown>[] = [];

  for (const model of [...new Set([PRIMARY_MODEL, BACKUP_MODEL])]) {
    const res = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys.llm}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with OK." }], max_completion_tokens: 200 }),
      signal,
    });
    const body = await res.json().catch(() => ({}));
    const h = (name: string) => res.headers.get(name);
    if (res.ok) {
      const perDay = h("x-ratelimit-limit-requests");
      const left = h("x-ratelimit-remaining-requests");
      const tpm = h("x-ratelimit-limit-tokens");
      lines.push(`- **${model}** (Groq): works.` +
        (perDay ? ` Free limit: ${perDay} requests a day (${left ?? "?"} left today)${tpm ? `, ${tpm} tokens a minute` : ""}.` : ""));
      report.push({ model, ok: true, perDay, left, tpm });
    } else {
      const err = explainLlmError(res, body, model);
      const raw = String((body as { error?: { message?: string } })?.error?.message ?? "").slice(0, 200);
      lines.push(`- **${model}** (Groq): HTTP ${res.status}. ${err.message}${raw ? ` Groq says: "${raw}"` : ""}`);
      report.push({ model, ok: false, status: res.status, raw });
    }
  }

  send("status", { kind: "search", text: "Testing web search…" });
  const res = await fetch(`${TAVILY_BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys.tavily}` },
    body: JSON.stringify({ query: "PSO petrol price Pakistan", search_depth: "basic", max_results: 3 }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    const n = (body as { results?: unknown[] }).results?.length ?? 0;
    lines.push(`- **Web search** (Tavily): works, ${n} results. The free plan includes 1,000 searches a month.`);
    report.push({ tavily: true, results: n });
  } else {
    const err = explainSearchError(res, body);
    lines.push(`- **Web search** (Tavily): HTTP ${res.status}. ${err.message}`);
    report.push({ tavily: false, status: res.status });
  }

  lines.push(
    "",
    "Groq also has a daily token limit that it doesn't report here: see console.groq.com/settings/limits. " +
      "Each question uses 1 to 4 Groq requests (more when it searches), plus one Tavily credit per web search.",
  );
  console.log(`research-agent /check ${JSON.stringify(report)}`);
  return { answer: lines.join("\n"), sources: [], navigate: null, search_suggestions: null, truncated: false, model: PRIMARY_MODEL };
}

/** Validates the request body and builds the conversation to send. */
export function parseBody(body: unknown): Message[] | string {
  const { message, history } = (body ?? {}) as { message?: unknown; history?: unknown };
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_CHARS) {
    return `Send a message of 1 to ${MAX_MESSAGE_CHARS} characters.`;
  }
  const turns: Turn[] = [];
  if (history !== undefined) {
    if (!Array.isArray(history)) return "history must be a list.";
    let total = 0;
    // Keep the most recent turns that fit in the budget.
    for (const turn of history.slice(-MAX_HISTORY_TURNS).reverse()) {
      const { role, text } = (turn ?? {}) as { role?: unknown; text?: unknown };
      if ((role !== "user" && role !== "assistant") || typeof text !== "string" || !text.trim()) return "Invalid history entry.";
      const kept = text.slice(0, MAX_TURN_CHARS);
      if ((total += kept.length) > MAX_HISTORY_CHARS) break;
      turns.unshift({ role, text: kept });
    }
  }
  while (turns.length && turns[0].role !== "user") turns.shift(); // the conversation must start with the user
  return [
    ...turns.map((t): Message => ({ role: t.role, content: t.text })),
    { role: "user", content: message.trim() },
  ];
}

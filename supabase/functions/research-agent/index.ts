// Logistix research assistant: an admin-only chat that researches transportation and
// logistics topics on the web and can open sections of Logistix.
//
// POST with the signed-in user's access token (Authorization: Bearer ...) and JSON
//   {"message": "...", "history": [{"role": "user" | "assistant", "text": "..."}]}
// and it streams back server-sent events:
//   status {kind, text}   what it's doing right now ("Searching: ...")
//   text   {delta}        reply text as it's written
//   done   {answer, sources: [{url, title}], navigate: {view, title, go_now} | null, truncated}
//   error  {message}      safe to show the user
//
// Needs the ANTHROPIC_API_KEY secret (Supabase dashboard > Edge Functions > Secrets).

import Anthropic from "npm:@anthropic-ai/sdk@0.128.0";

const MODEL = "claude-opus-5";
const EFFORT = "medium";
const MAX_TOKENS = 64000;
// On a safety-classifier decline, the API retries on the model Anthropic recommends
// for that refusal category, inside the same call.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
// Supabase stops a function after 150 s on the free plan; leave room to report back.
const TIME_LIMIT_MS = 125_000;
const MAX_STEPS = 12;
const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARS = 12000;
const ALLOWED_ORIGINS = ["https://abwebstudioofficial-web.github.io"];

const SECTIONS = [
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

function systemPrompt(): string {
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
2. Finding their way around Logistix: when a section is where the user wants to go, or where \
they would act on your answer, open it with open_section.

How to research:
- Use web_search to find sources and web_fetch to read the most promising pages in full. \
Prefer primary sources: regulators (OGRA, FBR, NHA), port authorities, shipping lines, and \
official notifications over blogs and aggregators.
- Each reply has about two minutes, so run a few focused searches, read only the most useful \
pages, then answer.
- Skip web research when the user only wants to open a section or asks how to use Logistix.
- Between tool calls, keep any notes to the user to one short sentence.

Opening sections:
- Call open_section with one of the section keys listed below, at most once per reply.
- Set go_now to true only when the user asked to be taken there. Otherwise set it to false and \
they will see a button to the section.
- You cannot look up individual orders, invoices or other records. If asked about one, open the \
section where they can find it and say so.

How to answer:
- The chat panel is narrow. Open with the answer in a sentence or two, then key details as a \
short list. Stay under about 250 words unless the user asks for more depth.
- Cite sources inline as Markdown links; the panel lists every page you read separately.
- Say plainly when sources disagree or information may be out of date. Do not guess.
- Stay focused on transportation, logistics and using Logistix. If asked about something \
unrelated, say briefly that you are set up for transportation and logistics research.

Logistix sections:
${sections}

Today's date is ${today}.`;
}

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4, max_content_tokens: 20000 },
  {
    name: "open_section",
    description:
      "Open a section of Logistix for the user. Call it when the user asks to go to a section, " +
      "or when one section is clearly where they would act on your answer. At most once per reply.",
    input_schema: {
      type: "object",
      properties: {
        view: { type: "string", enum: SECTIONS.map((s) => s.view), description: "Key of the section to open." },
        go_now: {
          type: "boolean",
          description: 'true only if the user asked to be taken there ("open...", "take me to..."). false shows a button instead.',
        },
      },
      required: ["view", "go_now"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
];

type Send = (event: string, data: Record<string, unknown>) => void;
type Source = { url: string; title: string | null };
type Destination = { view: string; title: string; go_now: boolean };
type Turn = { role: "user" | "assistant"; text: string };

class AgentError extends Error {}
class Refused extends Error {}

// -- the agent loop ------------------------------------------------------------------

async function answer(client: Anthropic, messages: Anthropic.Beta.BetaMessageParam[], send: Send, signal: AbortSignal) {
  const system = systemPrompt();
  const sources = new Map<string, Source>();
  let destination: Destination | null = null;
  let jsonRetries = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages,
        tools: TOOLS,
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT },
        cache_control: { type: "ephemeral" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
      },
      { signal },
    );
    stream.on("text", (delta) => send("text", { delta }));
    stream.on("streamEvent", (event) => {
      if (event.type !== "content_block_start") return;
      if (event.content_block.type === "thinking") send("status", { kind: "thinking", text: "Thinking…" });
      if (event.content_block.type === "fallback") send("status", { kind: "fallback", text: "Switching models to continue…" });
    });
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use" && block.name === "web_search") {
        send("status", { kind: "search", text: `Searching: ${String((block.input as { query?: unknown }).query ?? "")}` });
      } else if (block.type === "server_tool_use" && block.name === "web_fetch") {
        send("status", { kind: "read", text: `Reading: ${hostname(String((block.input as { url?: unknown }).url ?? ""))}` });
      } else if (block.type === "tool_use" && block.name === "open_section") {
        send("status", { kind: "navigate", text: "Finding the right section…" });
      }
    });

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Only a tool input the SDK couldn't parse at all is retried; API errors
      // (including the time limit abort) are rethrown.
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      send("status", { kind: "notice", text: "Retrying…" });
      continue;
    }

    if (message.stop_reason === "refusal") throw new Refused();

    const content = historyContent(message.content);
    collectSources(content, sources);
    messages.push({ role: "assistant", content: content as Anthropic.Beta.BetaContentBlockParam[] });

    // The server-side tool loop hit its iteration limit; sending the history back resumes it.
    if (message.stop_reason === "pause_turn") continue;

    const toolUses = content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      return {
        answer: finalText(message.content),
        sources: [...sources.values()],
        navigate: destination,
        truncated: message.stop_reason === "max_tokens",
      };
    }
    // A cut-off tool input can still parse as a valid partial object.
    if (message.stop_reason === "max_tokens") throw new AgentError("A tool call was cut off.");

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((block) => {
      const opened = openSection(block);
      if (typeof opened === "string") {
        return { type: "tool_result", tool_use_id: block.id, content: opened, is_error: true };
      }
      destination = opened;
      const note = opened.go_now
        ? `${opened.title} will open when your reply finishes.`
        : `The user will see a button to ${opened.title} under your reply.`;
      return { type: "tool_result", tool_use_id: block.id, content: note };
    });
    messages.push({ role: "user", content: results });
  }
  throw new AgentError("It stopped after too many steps without an answer.");
}

/** Validates an open_section call. Returns the destination, or an error message. */
function openSection(block: Anthropic.Beta.BetaToolUseBlock): Destination | string {
  if (block.name !== "open_section") return `Unknown tool: ${block.name}`;
  const input = block.input as { view?: unknown; go_now?: unknown } | null;
  if (!input || typeof input.view !== "string" || typeof input.go_now !== "boolean") {
    return JSON.stringify({ INVALID_JSON: JSON.stringify(block.input) });
  }
  const section = SECTIONS.find((s) => s.view === input.view);
  if (!section) return `"${input.view}" is not a Logistix section. Use one of the listed keys.`;
  return { view: section.view, title: section.title, go_now: input.go_now };
}

/**
 * The blocks of a response to keep in the history. After a mid-output fallback, only text
 * and completed server-tool calls from before the last `fallback` block may be sent back.
 */
function historyContent(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlock[] {
  const boundary = content.map((b) => b.type).lastIndexOf("fallback");
  if (boundary < 0) return content;
  const before = content.slice(0, boundary);
  const callIds = new Set(before.flatMap((b) => (b.type === "server_tool_use" ? [b.id] : [])));
  const resultIds = new Set(before.flatMap((b) => (b.type.endsWith("_tool_result") && "tool_use_id" in b ? [b.tool_use_id] : [])));
  const kept = before.filter((b) =>
    b.type === "text" ||
    (b.type === "server_tool_use" && callIds.has(b.id) && resultIds.has(b.id)) ||
    (b.type.endsWith("_tool_result") && "tool_use_id" in b && callIds.has(b.tool_use_id) && resultIds.has(b.tool_use_id))
  );
  return [...kept, ...content.slice(boundary + 1)];
}

/** The reply: text after the last tool call, result, or fallback. Earlier text is interim notes. */
function finalText(content: Anthropic.Beta.BetaContentBlock[]): string {
  const tail: string[] = [];
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block.type === "thinking" || block.type === "redacted_thinking") continue;
    if (block.type !== "text") break;
    tail.unshift(block.text);
  }
  return tail.join("").trim();
}

function collectSources(content: Anthropic.Beta.BetaContentBlock[], sources: Map<string, Source>) {
  for (const block of content) {
    if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
      const url = block.content.url;
      if (!sources.has(url)) sources.set(url, { url, title: block.content.content.title ?? null });
    } else if (block.type === "text") {
      for (const citation of block.citations ?? []) {
        if (citation.type === "web_search_result_location" && !sources.has(citation.url)) {
          sources.set(citation.url, { url: citation.url, title: citation.title ?? null });
        }
      }
    }
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function userMessage(err: unknown, timedOut: boolean): string {
  if (timedOut) return "That took too long for one reply. Try a narrower question.";
  if (err instanceof Refused) return "Sorry, I can't help with that request.";
  if (err instanceof AgentError) return `Sorry, I couldn't finish that: ${err.message}`;
  if (err instanceof Anthropic.AuthenticationError) return "The assistant's Anthropic API key is invalid. Check the ANTHROPIC_API_KEY secret in Supabase.";
  if (err instanceof Anthropic.RateLimitError) return "The assistant is busy right now. Please try again in a minute.";
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.InternalServerError) {
    return "The assistant couldn't reach its AI service. Please try again.";
  }
  return "Something went wrong. Please try again.";
}

// -- request handling ------------------------------------------------------------------

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });
}

/** Returns an error response unless the request comes from a signed-in Logistix admin. */
async function requireAdmin(req: Request): Promise<Response | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? req.headers.get("apikey") ?? "";
  if (!token || !supabaseUrl) return json(req, 401, { error: "Please sign in to use the research assistant." });

  const headers = { apikey: anonKey, Authorization: `Bearer ${token}` };
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, { headers });
  const user = userRes.ok ? await userRes.json() : null;
  if (!user?.id) return json(req, 401, { error: "Please sign in to use the research assistant." });

  const profileRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role`, { headers });
  const rows = profileRes.ok ? await profileRes.json() : [];
  if (!Array.isArray(rows) || rows[0]?.role !== "admin") {
    return json(req, 403, { error: "The research assistant is only available to admins." });
  }
  return null;
}

/** Validates the request body and builds the conversation to send. */
function parseBody(body: unknown): Anthropic.Beta.BetaMessageParam[] | string {
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
  while (turns.length && turns[0].role !== "user") turns.shift(); // the conversation must start with the user
  return [
    ...turns.map((t) => ({ role: t.role, content: t.text })),
    { role: "user" as const, content: message.trim() },
  ];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Use POST." });

  const denied = await requireAdmin(req);
  if (denied) return denied;
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return json(req, 503, { error: "The research assistant isn't set up yet: add the ANTHROPIC_API_KEY secret in Supabase." });
  }

  let messages: Anthropic.Beta.BetaMessageParam[] | string;
  try {
    messages = parseBody(await req.json());
  } catch {
    messages = "Send JSON.";
  }
  if (typeof messages === "string") return json(req, 400, { error: messages });

  const timeLimit = AbortSignal.timeout(TIME_LIMIT_MS);
  const signal = AbortSignal.any([timeLimit, req.signal]); // also stop if the user closes the panel
  const client = new Anthropic({ maxRetries: 1 });
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send: Send = (event, data) => {
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {});
  };

  const work = (async () => {
    try {
      send("done", await answer(client, messages, send, signal));
    } catch (err) {
      if (!req.signal.aborted) console.error("research-agent turn failed", err);
      send("error", { message: userMessage(err, timeLimit.aborted) });
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  // Keep the worker alive while the reply streams (Supabase otherwise treats a
  // returned response as finished work).
  (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(work);

  return new Response(readable, {
    headers: { ...corsHeaders(req), "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});

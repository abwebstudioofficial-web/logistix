// Logistix research assistant: an admin-only chat that researches transportation and
// logistics topics on the web and can open sections of Logistix. Runs on the Gemini API
// free tier with Grounding with Google Search.
//
// POST with the signed-in user's access token (Authorization: Bearer ...) and JSON
//   {"message": "...", "history": [{"role": "user" | "assistant", "text": "..."}]}
// and it streams back server-sent events:
//   status {kind, text}   what it's doing right now ("Thinking…", "Searched: ...")
//   text   {delta}        reply text as it's written
//   done   {answer, sources: [{url, title}], navigate: {view, title, go_now} | null,
//           search_suggestions: html | null, truncated, model}
//   error  {code, message}  code is one of daily_limit, minute_limit, invalid_key, not_set_up,
//                           region, blocked, busy, timeout, error; message is safe to show
//
// Secrets (Supabase dashboard > Edge Functions > Secrets):
//   GEMINI_API_KEY  required, a Gemini API key from Google AI Studio
//   GEMINI_MODEL    optional, defaults to gemini-2.5-flash

import { answer, type Content, parseBody, type Send, TIME_LIMIT_MS, UserError } from "./gemini.ts";

const ALLOWED_ORIGINS = ["https://abwebstudioofficial-web.github.io"];

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Use POST." });

  const denied = await requireAdmin(req);
  if (denied) return denied;
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) {
    return json(req, 503, { code: "not_set_up", error: "The research assistant isn't set up yet: add the GEMINI_API_KEY secret in Supabase (Edge Functions → Secrets)." });
  }

  let contents: Content[] | string;
  try {
    contents = parseBody(await req.json());
  } catch {
    contents = "Send JSON.";
  }
  if (typeof contents === "string") return json(req, 400, { error: contents });

  const timeLimit = AbortSignal.timeout(TIME_LIMIT_MS);
  const signal = AbortSignal.any([timeLimit, req.signal]); // also stop if the user closes the panel
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send: Send = (event, data) => {
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {});
  };

  const work = (async () => {
    try {
      send("done", await answer(key, contents, send, signal));
    } catch (err) {
      if (err instanceof UserError) {
        send("error", { code: err.code, message: err.message });
      } else if (timeLimit.aborted) {
        send("error", { code: "timeout", message: "That took too long for one reply. Try a narrower question." });
      } else {
        if (!req.signal.aborted) console.error("research-agent turn failed", err);
        send("error", { code: "error", message: "The assistant couldn't reach Gemini. Please try again." });
      }
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

# Research assistant (Edge Function)

The server side of the **✦ Research** chat panel in Logistix. It researches
transportation and logistics topics with Google's Gemini API and Grounding with
Google Search, on the free tier, and it can open Logistix sections for the user.
Only signed-in users whose profile role is `admin` can use it: `index.html` shows
the panel only to admins, and this function checks the role again on every
message.

| Piece | Where |
| --- | --- |
| Chat panel | `research-agent.js`, loaded by `index.html` |
| Turning it on for admins | the "Research assistant chat panel" `useEffect` in `LogistixERP` (`index.html`) |
| Request handling and the admin check | `supabase/functions/research-agent/index.ts` |
| Gemini request, prompt, sections and error messages | `supabase/functions/research-agent/gemini.ts` |
| Free-tier check | `supabase/scripts/check-gemini.ts` |

## Setup

1. Create a free API key in [Google AI Studio](https://aistudio.google.com/apikey).
2. In the Supabase dashboard, open **Edge Functions → Secrets** and add a secret
   named **`GEMINI_API_KEY`** with that key as its value.
3. Deploy the function: `supabase functions deploy research-agent`, or ask the
   maintenance agent to deploy it. **Merging the code doesn't change the live
   function**: until it's redeployed, Supabase keeps running the previous version.

Optional: add a `GEMINI_MODEL` secret to use a different model. The default is
`gemini-2.5-flash`.

## How it works

- Each question is **one** Gemini request with the `google_search` tool, so the
  free daily limit goes as far as possible.
- Gemini 2.5 models can't combine Google Search with custom functions in one
  request. So to open a section, the reply ends with a marker line such as
  `[[open:invoices]]`, or `[[open:invoices:now]]` when the user asked to go
  there. The function strips the marker, checks the key against `SECTIONS`, and
  tells the panel. The user never sees the marker.
- When `gemini-2.5-flash` hits its daily limit, the question is retried once on
  `gemini-2.5-flash-lite`, which has its own daily limit.
- Google's terms for grounded answers require showing Google's **Search
  Suggestions** with them. The panel shows them under each answer, in a
  sandboxed frame.

## Free-tier limits

Google no longer publishes a fixed free-tier table, and the limits have changed
several times. Reports from 2026 say:
- Free Google Search grounding is available on `gemini-2.5-flash` and
  `gemini-2.5-flash-lite`, about 500 grounded requests a day, shared between them.
- Request limits per model per day have been as low as about 20.

The live numbers for your key are shown in Google AI Studio. To measure them, run:

```bash
# One grounded question per Flash model: does grounding actually work on this key?
GEMINI_API_KEY=... deno run --allow-net --allow-env supabase/scripts/check-gemini.ts

# Ask until Google refuses, then print the real per-minute and per-day limits.
# This uses up the day's free quota for that model.
GEMINI_API_KEY=... deno run --allow-net --allow-env supabase/scripts/check-gemini.ts --until-limit gemini-2.5-flash
```

Daily limits reset at midnight Pacific time, which is around 12:00–1:00 pm in
Pakistan.

## Messages users see

| Situation | Message |
| --- | --- |
| Daily free limit used up | "Today's free Gemini limit has been reached. It resets at midnight Pacific time (about 12:00–1:00 pm in Pakistan)…" |
| Too many questions in a minute | "Too many questions in the last minute… wait about N seconds" |
| Invalid key | "The Gemini API key is invalid. Check the GEMINI_API_KEY secret in Supabase…" |
| Key blocked or not a Gemini key | "Google rejected the Gemini API key: …" |
| No key set | "The research assistant isn't set up yet: add the GEMINI_API_KEY secret…" |
| Safety filter | "Gemini declined to answer that. Try rephrasing the question." |
| Gemini overloaded | "Gemini is busy or having a problem right now…" |

## Privacy

Google's terms for the free (unpaid) Gemini API allow Google to use prompts and
answers to improve its products, and people may review them. Don't type
confidential business details, such as customer names, rates or contract terms,
into the assistant. The function only sends the user's questions and earlier
answers from the same chat, never Logistix data.

## Changing it

- **Sections it can open:** edit `SECTIONS` in `gemini.ts`. Each `view` must match
  a `key` in `NAV_ITEMS` in `index.html`.
- **What it researches and how it answers:** edit `systemPrompt()` in `gemini.ts`.
- **Who can use it:** the role check is in `requireAdmin()` in `index.ts` and in
  the `enabled:` line of the effect in `index.html`. Change both.

# Research assistant (Edge Function)

The server side of the **✦ Research** chat panel in Logistix. It researches
transportation and logistics topics on the web, finds records in Logistix itself,
and can open Logistix sections for the user. It runs on two free services, and
neither needs a card:

- **[Groq](https://console.groq.com)** runs the AI model (`openai/gpt-oss-120b`).
- **[Tavily](https://app.tavily.com)** does the web searches.

Only signed-in users whose profile role is `admin` can use it: `index.html` shows
the panel only to admins, and this function checks the role again on every
message.

| Piece | Where |
| --- | --- |
| Chat panel | `research-agent.js`, loaded by `index.html` |
| Turning it on for admins | the "Research assistant chat panel" `useEffect` in `LogistixERP` (`index.html`) |
| Request handling and the admin check | `supabase/functions/research-agent/index.ts` |
| Model requests, web search, prompt, sections and error messages | `supabase/functions/research-agent/research.ts` |
| Finding Logistix records | `supabase/functions/research-agent/records.ts` |
| Opening a found record in the app | `openAssistantRecord` in `LogistixERP` (`index.html`) |

## Setup

1. Create a free Groq API key at [console.groq.com/keys](https://console.groq.com/keys).
2. Create a free Tavily API key at [app.tavily.com](https://app.tavily.com).
3. In the Supabase dashboard, open **Edge Functions → Secrets** and add two secrets:
   - **`GROQ_API_KEY`**: the Groq key;
   - **`TAVILY_API_KEY`**: the Tavily key.
4. Deploy the function: `supabase functions deploy research-agent`, or ask the
   maintenance agent to deploy it. **Merging the code doesn't change the live
   function**: until it's redeployed, Supabase keeps running the previous version.

The old `GEMINI_API_KEY` secret isn't used any more and can be deleted.

Optional secrets:
- `LLM_MODEL` chooses another Groq model instead of `openai/gpt-oss-120b`.
- `LLM_BASE_URL` switches to another OpenAI-compatible provider. Put that
  provider's key in `LLM_API_KEY`.

**To check it's working, type `/check` in the panel.** It tests both Groq models
with your real key and shows the limits Groq reports for them: requests per day,
requests left today, and tokens per minute. It also runs one Tavily search. The
check uses two small Groq requests and one Tavily credit. The same report goes to
the function's logs in Supabase.

## How it works

- For each question, the model decides whether it needs to search. If it does,
  it calls the `web_search` tool, which runs a Tavily search. It can search up to
  three times per question and then answers from what it read. The answer links
  the pages it used, and the panel lists them under **Sources**.
- **Current prices:** fuel prices in Pakistan can change every few days. So for
  prices and rates, the model is told to search recent news with today's date
  (in Pakistan time) and to give the date each rate applies from. It prefers
  official sources such as OGRA, the Petroleum Division and Radio Pakistan over
  aggregator sites, and says so when its newest source is older than today.
- To take the user to a part of Logistix, the model calls the `open_section`
  tool. The function checks the section against `SECTIONS`, then tells the panel
  to show an "Open … →" button, or to switch straight there when the user asked
  to go. If the model doesn't pick a section, questions about topics in
  `TOPIC_SECTIONS` still get a button: fuel prices go to Fuel Management, and
  freight rates to Contracts.
- **Tidying answers:** the model sometimes cites sources as `【url】` and uses
  unusual space characters. The function turns those citations into normal links
  and the spaces into ordinary ones.
- **Backup model:** each Groq model has its own daily limits. When
  `openai/gpt-oss-120b` reaches its limit or is retired, the question moves to
  `openai/gpt-oss-20b`.
- **Keeping within the per-minute limit:** Groq's free plan allows 8,000 tokens a
  minute, and each step of a question resends the conversation. So the function
  asks for low reasoning effort, keeps about 700 characters of each search result,
  and sends at most 6,000 characters of earlier chat. If Groq asks it to wait 20
  seconds or less, it waits and carries on.
- **Logs:** every error from Groq or Tavily is written to the function's logs in
  Supabase. The keys never are.

## Finding records in Logistix

Ask for something stored in Logistix, for example "show me order ORD-…", "find
container MSKU1234567", "open invoice INV-2026-5922" or "vehicle TLE911". The
model calls the `find_records` tool with the number or name, and `records.ts`
searches:

| Record | Searched by |
| --- | --- |
| Orders | order, job, PO and BL numbers, and each container's container, vehicle, bilty, shifted-container, transporter-bill and PO/SAP numbers; also the customer's name |
| Invoices | invoice number, container, the customer's name, and invoices of the orders found |
| Transporters | name, contact, phone, email |
| Contracts | contract title, the customer's name |

- **The database does the searching, not the AI.** The function sends read-only
  `GET` requests to Supabase's REST API with **the signed-in user's own access
  token**, so row-level security decides what they can see. A customer account
  would only find its own orders and invoices, for example. It never writes.
- Numbers match however they're punctuated or spaced: `TLE-911`, `tle911` and a
  stored `" TLE911"` are the same. Each row the database returns is then checked
  against the actual fields, so a record is only offered when one of its numbers
  or names really contains what was asked. When something matches exactly, near
  misses (`TLE9110` for `TLE911`) are left out.
- **The AI sees only the matches**, at most 10, each as a label, what matched and
  a one-line summary. It never sees ids, other fields or other records.
- **The buttons come from the database rows**, not from the AI's text, so they
  can't point to a record that doesn't exist. Each one opens:
  - an **order** or **invoice**: its existing view popup (the same "Order
    Details" / "Invoice Details" popup the app uses), over the matching orders
    page or the Invoices page;
  - a **transporter**: the Transporters page, filtered to it (transporters have
    no view popup);
  - a **contract**: that contract's page under Contracts (contracts have no view
    popup either).
  None of them opens an edit form.
- If nothing matches, the answer says so and the panel adds "Not in Logistix: …".
- Limits: up to 3 record searches and 10 buttons per question; the newest
  matches come first, and the model is told roughly how many there are in all.
  Only the first 20 containers of each order are searched (no order has more than
  2 so far). A record question uses one or two Groq requests and no Tavily credit.

## Free limits

Free-plan limits published for September 2026. Type `/check` to see what your
own keys actually get.

| Service | Limit |
| --- | --- |
| Groq `openai/gpt-oss-120b` | 30 requests a minute, 1,000 requests a day, 8,000 tokens a minute, 200,000 tokens a day |
| Groq `openai/gpt-oss-20b` (backup) | its own, similar daily limits |
| Tavily | 1,000 credits a month, reset on the 1st of each month; each search uses 1 credit |

Groq's limits apply to the whole Groq organization, so extra keys don't add to
them. The live numbers are at
[console.groq.com/settings/limits](https://console.groq.com/settings/limits), and
Tavily usage is on the [Tavily dashboard](https://app.tavily.com).

In practice, the **daily token limit** is the one you reach first. A question
without a search uses about 2,000 tokens, and one with searches about
5,000–8,000. That's roughly 30–100 questions a day on the main model, depending
on how many need a search, and about as many again on the backup. Tavily's 1,000
credits cover about 500 searching questions a month.

## Messages users see

| Situation | Message |
| --- | --- |
| Daily free limit used up (both models) | "Today's free Groq limit for the assistant has been reached. Please try again in about N minutes." |
| Too many questions in a minute | "Too many questions in the last minute for the free Groq limit. Please wait about N seconds and try again." |
| Question too big for the per-minute limit | "This question needs more text than Groq's free per-minute limit allows…" |
| Monthly searches used up | "This month's free web searches (1,000 Tavily credits) are used up. They reset on the 1st of next month." |
| Invalid Groq key | "The Groq API key is invalid. Check the GROQ_API_KEY secret in Supabase (Edge Functions → Secrets)." |
| Groq account blocked | "Groq refused the request: <Groq's reason>…" |
| Invalid Tavily key | "The Tavily API key is invalid. Check the TAVILY_API_KEY secret in Supabase (Edge Functions → Secrets)." |
| A key isn't set | "The research assistant isn't set up yet: add the GROQ_API_KEY and TAVILY_API_KEY secret(s)…" |
| Groq or Tavily down | "Groq is busy or having a problem right now…" / "Web search failed…" |
| Conversation too long | "This conversation has grown too long. Click "New chat" and ask again." |
| No record matches | The answer says it isn't in Logistix, and the panel adds "Not in Logistix: “…”" |
| Sign-in expired during a record search | "Your sign-in has expired. Reload the page, sign in again and ask again." |
| Record search failed | "Couldn't search Logistix records right now (HTTP N). Please try again." |
| A found record can't be opened (deleted since) | "Couldn't open … here. It may have been deleted; try reloading the page." |

## Privacy

Questions and earlier answers from the same chat go to Groq. The model's search
queries go to Tavily. When the assistant looks up Logistix records, the one-line
summaries of the matches (at most 10) also go to Groq: the record's number, what
matched, the customer's short name, route and dates, and an invoice's status and
total. No other Logistix data is sent, and nothing from Logistix goes to Tavily.

Groq's terms say it doesn't train models on API inputs or outputs, and it doesn't
keep them by default. It may log them for up to 30 days when it's troubleshooting
errors or investigating abuse. You can turn that logging off with the zero data
retention setting in the Groq console
([Your data in GroqCloud](https://console.groq.com/docs/your-data)). Even so,
don't type confidential details such as customer names, rates or contract terms
into the assistant.

## Changing it

- **Sections it can open:** edit `SECTIONS` in `research.ts`. Each `view` must
  match a `key` in `NAV_ITEMS` in `index.html`.
- **Which topics always get a section button:** edit `TOPIC_SECTIONS` in `research.ts`.
- **What record search looks at:** edit `findRecords` in `records.ts` (the
  fields searched) and `openAssistantRecord` in `index.html` (what a button opens).
- **What it researches and how it answers:** edit `systemPrompt()` in `research.ts`.
- **Who can use it:** the role check is in `requireAdmin()` in `index.ts` and in
  the `enabled:` line of the effect in `index.html`. Change both.

# Research assistant (Edge Function)

The server side of the **✦ Research** chat panel in Logistix. It researches
transportation and logistics topics on the web, and it can open Logistix sections
for the user. It runs on two free services, and neither needs a card:

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
- To take the user to a part of Logistix, the model calls the `open_section`
  tool. The function checks the section against `SECTIONS`, then tells the panel
  to show an "Open … →" button, or to switch straight there when the user asked
  to go.
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

## Privacy

Questions and earlier answers from the same chat go to Groq. The model's search
queries go to Tavily. The function never sends Logistix data.

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
- **What it researches and how it answers:** edit `systemPrompt()` in `research.ts`.
- **Who can use it:** the role check is in `requireAdmin()` in `index.ts` and in
  the `enabled:` line of the effect in `index.html`. Change both.

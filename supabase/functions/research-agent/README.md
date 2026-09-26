# Research assistant (Edge Function)

The server side of the **✦ Research** chat panel in Logistix. It researches
transportation and logistics topics on the web with Claude, and it can open
Logistix sections for the user. Only signed-in users whose profile role is
`admin` can use it: `index.html` shows the panel only to admins, and this
function checks the role again on every message.

| Piece | Where |
| --- | --- |
| Chat panel | `research-agent.js`, loaded by `index.html` |
| Turning it on for admins | the "Research assistant chat panel" `useEffect` in `LogistixERP` (`index.html`) |
| Server (this function) | `supabase/functions/research-agent/index.ts` |

## Setup

1. Create an API key in the [Claude Console](https://platform.claude.com).
2. In the Supabase dashboard, open **Edge Functions → Secrets** and add a secret
   named `ANTHROPIC_API_KEY` with that key as its value. Until you do, the panel
   says it "isn't set up yet".

The function is already deployed as `research-agent`. After you change
`index.ts`, redeploy it with `supabase functions deploy research-agent`, or ask
Claude to deploy it for you.

## Changing it

- **Sections it can open:** edit `SECTIONS` in `index.ts`. Each `view` must match a
  `key` in `NAV_ITEMS` in `index.html`.
- **What it researches and how it answers:** edit `systemPrompt()` in `index.ts`.
- **Who can use it:** the role check is in `requireAdmin()` in `index.ts` and in
  the `enabled:` line of the effect in `index.html`. Change both.
- **Depth vs. speed:** `EFFORT` in `index.ts` (`"low"`, `"medium"` or `"high"`),
  and the `max_uses` limits on web searches and page reads.

## Limits and costs

- Each reply must finish within about two minutes, because Supabase stops
  functions after 150 seconds on the free plan. It keeps searches short and
  says so if a question takes too long.
- It uses Claude Opus 5 ($5 per million input tokens and $25 per million output
  tokens). Each web search is billed on top of that. See
  <https://platform.claude.com/docs/en/about-claude/pricing>.
- If Claude's safety filters decline a request, it's retried automatically on
  another Claude model (`fallbacks: "default"`).
- It can't look up individual orders or other records yet. It can only open the
  section where they are.

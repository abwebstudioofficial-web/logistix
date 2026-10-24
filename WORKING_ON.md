# Working on

One line per task in progress: who, what, which part of which file, branch. Remove your line when the PR is merged.

- Research assistant session: adding record search to the research assistant (find orders, invoices, transporters, contracts and open their existing view popup). Files: `supabase/functions/research-agent/*` (new `records.ts`, tool in `research.ts`), `research-agent.js` (record buttons), `index.html` (only the research-assistant `useEffect` config and a small hook for opening a record's view popup). Branch `claude/research-record-search`.

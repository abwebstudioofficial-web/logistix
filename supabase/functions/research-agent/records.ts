// Finds Logistix's own records (orders, invoices, transporters and contracts) for the
// research assistant. The searching is done by the database, through Supabase's REST API,
// with the signed-in user's own access token, so row-level security decides what each user
// can see. Read-only: it only ever sends GET requests. Used by research.ts.
//
// Numbers are matched however they're punctuated ("TLE-911" finds " TLE911", "LES2231" finds
// "LES-2231") with a case-insensitive regex that skips non-alphanumeric characters. Most
// vehicle, container and bilty numbers are kept per container in each order's `containers`
// JSON list; each of an order's first MAX_CONTAINER_SLOTS containers is searched as text
// (containers->>0, ->>1, ...), which works on every PostgREST version. Every row the database
// returns is then checked here against the actual fields, so a record is only offered when one
// of its numbers or names really contains what the user asked for.

export type Db = { url: string; anonKey: string; token: string };
export type RecordKind = "order" | "invoice" | "transporter" | "contract";
export type FoundRecord = { kind: RecordKind; id: string; label: string; detail: string; matched: string };
/** `total` is about how many records match in all, when there are more than the ones shown. */
export type Search = { query: string; records: FoundRecord[]; more: boolean; total: number };

export const RECORD_KINDS = ["any", "orders", "invoices", "transporters", "contracts"];
export const MAX_RECORDS = 10; // buttons shown per question
const FETCH_LIMIT = 30; // rows asked for per table; the closest matches are kept
const MAX_CONTAINER_SLOTS = 20; // containers searched per order (orders have had at most 2 so far)
const MAX_REGEX_CHARS = 16; // longer search text (a full name) uses a plain pattern, keeping URLs short

/** A failure with a message that is safe to show the user. */
export class RecordsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Letters and digits only, upper-cased, so "tle-911 " and "TLE911" compare equal. */
export function compact(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** The search text, keeping only characters that appear in record numbers and names. */
export function cleanTerm(query: unknown): string {
  return String(query ?? "").replace(/[^\p{L}\p{N} \-\/.&'#_]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

// PostgREST filter values in double quotes can hold spaces, commas and dots; cleanTerm has
// already removed the two characters that would need escaping (" and \).
const quote = (value: string) => `"${value}"`;
/** "ORD 12ab" -> *ORD*12ab*: matches whatever separators the stored text uses. */
const likePattern = (term: string) => quote(`*${term.split(/[^\p{L}\p{N}]+/u).filter(Boolean).join("*")}*`);
/**
 * A filter on `column` for the search text. For numbers it's a case-insensitive regex that
 * allows punctuation or spaces (\W*) between the letters and digits, so TLE911 becomes
 * T\W*L\W*E\W*9\W*1\W*1; inside PostgREST's quotes the backslash is written twice.
 */
export function matches(column: string, term: string): string {
  const chars = [...compact(term)];
  if (chars.length > MAX_REGEX_CHARS) return `${column}.ilike.${likePattern(term)}`;
  return `${column}.imatch.${quote(chars.join("\\\\W*"))}`;
}
const inList = (ids: string[]) => `(${ids.map(quote).join(",")})`;
// contract_groups.id is a uuid column: comparing it with anything else is a database error.
const isUuid = (term: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term);

async function get(db: Db, table: string, params: Record<string, string>, signal: AbortSignal, count = false) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const res = await fetch(`${db.url}/rest/v1/${table}?${qs}`, {
    method: "GET",
    headers: {
      apikey: db.anonKey,
      Authorization: `Bearer ${db.token}`,
      Accept: "application/json",
      ...(count ? { Prefer: "count=exact" } : {}),
    },
    signal,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.warn(`records ${table}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
    if (res.status === 401) {
      throw new RecordsError("signed_out", "Your sign-in has expired. Reload the page, sign in again and ask again.");
    }
    throw new RecordsError("records_failed", `Couldn't search Logistix records right now (HTTP ${res.status}). Please try again.`);
  }
  const total = Number((res.headers.get("content-range") ?? "").split("/")[1]);
  return { rows: (Array.isArray(body) ? body : []) as Row[], total: Number.isFinite(total) ? total : null };
}

type Row = Record<string, unknown>;
type Hit = { rank: number; matched: string };

/** How well one field matches: 0 exact, 1 starts with it, 2 contains it, null no match. */
function score(value: unknown, wanted: string): number | null {
  const v = compact(value);
  if (!v || !wanted) return null;
  if (v === wanted) return 0;
  if (v.startsWith(wanted)) return 1;
  return v.includes(wanted) ? 2 : null;
}

/** The best-matching field of a record, from [label, value] pairs. */
function bestField(fields: [string, unknown][], wanted: string): Hit | null {
  let best: Hit | null = null;
  for (const [label, value] of fields) {
    const s = score(value, wanted);
    if (s !== null && (!best || s < best.rank)) best = { rank: s, matched: `${label} ${String(value).trim()}` };
  }
  return best;
}

export function orderHit(row: Row, wanted: string, customerIds: Set<string>): Hit | null {
  const fields: [string, unknown][] = [
    ["order", row.order_number], ["job", row.job_number], ["PO", row.po_number], ["BL", row.bl_number],
    ["container", row.container_number], ["bilty", row.bilty_number], ["vehicle", row.vehicle_id],
  ];
  const containers = Array.isArray(row.containers) ? row.containers as Row[] : [];
  for (const c of containers) {
    if (!c || typeof c !== "object") continue;
    fields.push(
      ["container", c.containerNumber], ["vehicle", c.vehiclePlate], ["bilty", c.biltyNumber],
      ["shifted to container", c.shiftedContainerNo], ["transporter bill", c.transporterBillNo], ["PO/SAP", c.poSapNo],
    );
  }
  const hit = bestField(fields, wanted);
  if (hit) return hit;
  return customerIds.has(String(row.customer_id)) ? { rank: 3, matched: "customer" } : null;
}

/** `orders` maps the ids of orders that matched by number to how they matched. */
export function invoiceHit(row: Row, wanted: string, customerIds: Set<string>, orders: Map<string, { number: string; rank: number }>): Hit | null {
  const hit = bestField([["invoice", row.invoice_number], ["container", row.container_id]], wanted);
  if (hit) return hit;
  const order = orders.get(String(row.order_id));
  if (order) return { rank: order.rank, matched: `for order ${order.number}` };
  return customerIds.has(String(row.customer_id)) ? { rank: 3, matched: "customer" } : null;
}

const join = (...parts: unknown[]) => parts.map((p) => String(p ?? "").trim()).filter(Boolean).join(" · ");
const pkr = (n: unknown) => (Number.isFinite(Number(n)) && n !== null && n !== "" ? `PKR ${Number(n).toLocaleString("en-US")}` : "");

/**
 * Searches Logistix for a number or name. `kind` limits it to one type of record.
 * Returns the closest matches first, at most MAX_RECORDS of them.
 */
export async function findRecords(db: Db, query: string, kind: string, signal: AbortSignal): Promise<Search> {
  const term = cleanTerm(query);
  const wanted = compact(term);
  if (wanted.length < 3) {
    throw new RecordsError("too_short", "Give at least 3 letters or digits of the number or name to look for.");
  }
  const want = (k: string) => kind === "any" || kind === k || !RECORD_KINDS.includes(kind);

  // 1. Customers whose name matches: their orders, invoices and contracts count as matches.
  const { rows: customerRows } = await get(db, "customers", {
    select: "id,name,short_name",
    or: `(${matches("name", term)},${matches("short_name", term)},id.eq.${quote(term)})`,
    limit: "20",
  }, signal);
  const customerIds = new Set(customerRows.map((c) => String(c.id)));
  const byCustomer = customerIds.size ? [`customer_id.in.${inList([...customerIds])}`] : [];

  // 2. Orders, transporters and contracts, at the same time.
  const needOrders = want("orders") || want("invoices");
  const [orders, transporters, contracts] = await Promise.all([
    needOrders
      ? get(db, "orders", {
        select: "id,order_number,job_number,po_number,bl_number,container_number,bilty_number,vehicle_id,shipment_type," +
          "domestic_category,customer_id,origin,destination,created_date,cancelled,containers",
        or: "(" + [
          ...["order_number", "job_number", "po_number", "bl_number", "container_number", "bilty_number", "vehicle_id"]
            .map((col) => matches(col, term)),
          ...Array.from({ length: MAX_CONTAINER_SLOTS }, (_, i) => matches(`containers->>${i}`, term)),
          `id.eq.${quote(term)}`,
          ...byCustomer,
        ].join(",") + ")",
        order: "created_at.desc",
        limit: String(FETCH_LIMIT),
      }, signal, true)
      : null,
    want("transporters")
      ? get(db, "transporters", {
        select: "id,name,phone,contact,email",
        or: `(${["name", "contact", "phone", "email"].map((col) => matches(col, term)).join(",")},id.eq.${quote(term)})`,
        limit: String(FETCH_LIMIT),
      }, signal)
      : null,
    want("contracts")
      ? get(db, "contract_groups", {
        select: "id,customer_id,contract_title,commencement_date,expiry_date",
        or: "(" + [matches("contract_title", term), ...(isUuid(term) ? [`id.eq.${quote(term)}`] : []), ...byCustomer].join(",") + ")",
        order: "created_at.desc",
        limit: String(FETCH_LIMIT),
      }, signal)
      : null,
  ]);

  const orderHits = (orders?.rows ?? [])
    .map((row) => ({ row, hit: orderHit(row, wanted, customerIds) }))
    .filter((x): x is { row: Row; hit: Hit } => x.hit !== null);
  // Orders that matched by number (not just by customer): their invoices match too.
  const orderNumbers = new Map(orderHits.filter((x) => x.hit.rank < 3)
    .map((x) => [String(x.row.id), { number: String(x.row.order_number), rank: x.hit.rank }]));

  // 3. Invoices, now that the matching orders are known.
  const invoices = want("invoices")
    ? await get(db, "invoices", {
      select: "id,invoice_number,order_id,customer_id,container_id,issued,due,total,status",
      or: "(" + [
        matches("invoice_number", term), matches("container_id", term), `id.eq.${quote(term)}`, ...byCustomer,
        ...(orderNumbers.size ? [`order_id.in.${inList([...orderNumbers.keys()])}`] : []),
      ].join(",") + ")",
      order: "created_at.desc",
      limit: String(FETCH_LIMIT),
    }, signal)
    : null;

  type Candidate = { rank: number; kind: RecordKind; row: Row; matched: string };
  const candidates: Candidate[] = [];
  if (want("orders")) for (const { row, hit } of orderHits) candidates.push({ rank: hit.rank, kind: "order", row, matched: hit.matched });
  for (const row of invoices?.rows ?? []) {
    const hit = invoiceHit(row, wanted, customerIds, orderNumbers);
    if (hit) candidates.push({ rank: hit.rank, kind: "invoice", row, matched: hit.matched });
  }
  for (const row of transporters?.rows ?? []) {
    const hit = bestField([["name", row.name], ["contact", row.contact], ["phone", row.phone], ["email", row.email], ["id", row.id]], wanted);
    if (hit) candidates.push({ rank: hit.rank, kind: "transporter", row, matched: hit.matched });
  }
  for (const row of contracts?.rows ?? []) {
    const hit = bestField([["contract", row.contract_title], ["id", row.id]], wanted) ??
      (customerIds.has(String(row.customer_id)) ? { rank: 3, matched: "customer" } : null);
    if (hit) candidates.push({ rank: hit.rank, kind: "contract", row, matched: hit.matched });
  }
  // Closest matches first; the sort is stable, so each table's newest-first order is kept.
  // When something matches exactly, near misses (TLE9110 for TLE911) are left out.
  candidates.sort((a, b) => a.rank - b.rank);
  const best = candidates.length && candidates[0].rank === 0 ? candidates.filter((c) => c.rank === 0) : candidates;
  const shown = best.slice(0, MAX_RECORDS);

  // 4. Customer names for the labels.
  const names = new Map(customerRows.map((c) => [String(c.id), String(c.short_name || c.name || "")]));
  const missing = [...new Set(shown.map((c) => String(c.row.customer_id ?? "")).filter((id) => id && !names.has(id)))];
  if (missing.length) {
    const { rows } = await get(db, "customers", { select: "id,name,short_name", id: `in.${inList(missing)}` }, signal);
    for (const c of rows) names.set(String(c.id), String(c.short_name || c.name || ""));
  }
  const customer = (row: Row) => names.get(String(row.customer_id ?? "")) ?? "";
  const matchedText = (c: Candidate) => (c.matched === "customer" ? `customer ${customer(c.row)}` : c.matched);

  const records = shown.map((c): FoundRecord => {
    const r = c.row;
    if (c.kind === "order") {
      const route = r.origin || r.destination ? `${String(r.origin || "?").trim()} → ${String(r.destination || "?").trim()}` : "";
      return {
        kind: "order", id: String(r.id), label: `Order ${r.order_number}`, matched: matchedText(c),
        detail: join(r.shipment_type, r.domestic_category, customer(r), route, r.created_date, r.cancelled ? "Cancelled" : ""),
      };
    }
    if (c.kind === "invoice") {
      return {
        kind: "invoice", id: String(r.id), label: `Invoice ${r.invoice_number || r.id}`, matched: matchedText(c),
        detail: join(r.status, customer(r), pkr(r.total), r.issued ? `issued ${r.issued}` : ""),
      };
    }
    if (c.kind === "transporter") {
      return { kind: "transporter", id: String(r.id), label: `Transporter ${r.name}`, matched: matchedText(c), detail: join(r.phone, r.contact) };
    }
    const dates = r.commencement_date || r.expiry_date ? `${r.commencement_date || "?"} to ${r.expiry_date || "?"}` : "";
    return { kind: "contract", id: String(r.id), label: `Contract ${r.contract_title || "(untitled)"}`, matched: matchedText(c), detail: join(customer(r), dates) };
  });

  const more = best.length > MAX_RECORDS ||
    [orders, transporters, contracts, invoices].some((t) => t && t.rows.length >= FETCH_LIMIT) ||
    (orders?.total ?? 0) > (orders?.rows.length ?? 0);
  // The database's count of matching orders (it can include a few near misses).
  const total = Math.max(best.length, want("orders") ? (orders?.total ?? 0) + best.filter((c) => c.kind !== "order").length : best.length);
  return { query: term, records, more, total: more ? total : records.length };
}

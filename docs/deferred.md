# Deferred findings

Things the audit found, that were looked at, and that were deliberately NOT fixed —
each with the measurement behind that decision and the condition that should bring it
back. A finding with no reason attached eventually gets "fixed" by someone who does
not know why it was left, or forgotten by everyone; this file is the alternative.

Fixed findings are not listed here. They are in the CHANGELOG.

---

## The base grid loads a whole table into Node

**Status:** deferred — 2026-08-30
**Revisit when:** the largest table passes ~10 000 rows

`GET /api/tables/[id]/rows` runs `prisma.row.findMany({ where: { tableId } })` with no
`take`, then paginates with `.slice(offset, offset + limit)`. The `limit` parameter is
honoured in the response but not in the query, so the database returns the entire
table on every request.

The reason it is written that way is not laziness: view filters and sorting are
evaluated in JavaScript against the per-row `data` JSON, so the page cannot be
selected in SQL without moving that logic down as well. Doing so is real work.

### What the numbers actually say (measured on prod, 2026-08-30)

| table | rows | size |
|---|---|---|
| Decisions | 596 | 255 KB |
| Tasks | 574 | 179 KB |
| Walmart | 18 | 13 KB |
| Servers | 8 | 4 KB |
| Accounts | 3 | 2 KB |

1199 rows across 5 tables; the whole `Row` table is **896 KB**.

On the largest table, median over 7 runs:

- database query — **44.2 ms**
- the Node-side work the finding is about — **0.31 ms**
- payload in memory — 314 KB

The part being complained about is **140× cheaper than the query it follows**.
Optimising it would shave 0.3 ms off 44.

### Why 10 000 rows

Per row: 0.074 ms and 0.53 KB. Extrapolated:

| rows | query | memory |
|---|---|---|
| 600 (today) | 44 ms | 0.3 MB |
| 10 000 | ~740 ms | ~5 MB |
| 50 000 | ~3.7 s | ~26 MB |

Somewhere around 10 000 the request stops feeling instant, and that is the point to
push pagination into SQL — before 50 000, where it is 3.7 seconds and 26 MB **per
request**. Tasks reached 574 rows over months of daily use, so this is years away on
the current trajectory; it will not arrive suddenly.

**How to check:** the query in `scripts/` used for the measurement is not committed —
`SELECT "tableId", count(*) FROM "Row" GROUP BY 1 ORDER BY 2 DESC LIMIT 1` is enough.

---

## RDP: "the server-side graphics subsystem is in an error state"

**Status:** not fixable from this side — 2026-08-13
**Revisit when:** it recurs on a host that has been rebooted with no stuck session

Diagnosed to the Windows host, not to Garely: the RDP gateway was healthy, TCP to
every target answered in 0.01–0.15 s, and all hosts sustained 1.5–2.7 hour sessions
normally before and after. The remedy is host-side — log off the stuck session, or
reboot, or disable the hardware graphics adapter by policy.

What could still be added on our side is a friendlier message and a retry when this
specific error comes back from the gateway, so the user is told what it means instead
of reading a raw protocol error. That has not been done.

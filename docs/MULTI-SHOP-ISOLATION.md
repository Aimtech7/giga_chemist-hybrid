# Multi-shop isolation (synthetic Shop 2 only)

No real Shop 2 exists. Tests register a **synthetic** Shop 2 (own token, own data through the real
ingestion RPCs) in the test cloud only.

## Rule

Every online request resolves its authorized shop on the SERVER (account type + `X-GIGA-SHOP-ID`) and
stores it on the request; every cloud read runs read-only with that shop set. A browser can never widen it
by changing the URL, query, `shop_id`, body or storage:

| Request | Result |
|---|---|
| shop account asking for another shop | 403 `SHOP_ACCESS_DENIED` (audited) |
| Global Admin, one shop selected | that shop only |
| Global Admin, All Shops | read-only views; every write needs one selected shop |
| `shop_id` filter outside the authorized list | 403 (history, sold medicines, insights, business day) |
| staff account of another shop in User management | 409 "belongs to another shop" |
| command / shift / alert of another shop | not listed; retry / review refused |

## Covered by tests

unified-auth (TEST 1-33: medicines, sales, staff, reports, commands, health, concurrency 30 interleaved
requests; P13 profile edits), stock-history (SOLD 7-9, IN15, BD9), shifts (Shop 2 shifts), sync center
(SC5 / SC6: a shop Administrator sees only its own shop), full-write (fan-out per shop).

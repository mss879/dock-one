# Scheduled jobs — cart recovery (hourly) and maintenance (daily)

Blueprint §18 "Schedule the jobs": two POST endpoints, each authorised by its own bearer secret.
Neither job runs by itself — something outside the app must call them on a schedule. Until they
are scheduled, abandoned checkouts are captured but **no reminder is ever sent**, and **nothing is
ever pruned** (so the retention periods on the privacy page would not be true).

| Job | Endpoint | When | Bearer secret (env = database) | What it does |
| --- | --- | --- | --- | --- |
| Cart recovery | `POST /api/cart-recovery` | **hourly** | `CART_RECOVERY_SECRET` = `app_config.cart_recovery` | Emails the 3 abandoned-cart reminders (1 h, 24 h, 72 h after a checkout stops), up to 20 carts per reminder per run (`src/lib/cart-recovery.ts`) |
| Maintenance | `POST /api/maintenance` | **daily** | `MAINTENANCE_SECRET` = `app_config.maintenance` | `run_retention()` — deletes what the privacy page says is not kept (blueprint §12.5; route by WP-H) |

## 1. Secrets (once)

Generate them in the Supabase SQL editor and put the **same** values in the host's environment
(each ≥ 20 characters — a shorter or unset secret keeps the job closed):

```sql
INSERT INTO public.app_config (name, value) VALUES
  ('cart_recovery', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('maintenance',   replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
SELECT name, value FROM public.app_config WHERE name IN ('cart_recovery', 'maintenance');
```

```bash
CART_RECOVERY_SECRET=<value of cart_recovery>
MAINTENANCE_SECRET=<value of maintenance>
```

Cart recovery also needs email: `RESEND_API_KEY` and `RESEND_FROM_EMAIL` (a verified domain).
Without them the job answers 503 and claims nothing.

## 2. Schedule

Any scheduler that can send a **POST with an `Authorization` header** works (a server's crontab,
a CI scheduled workflow, a hosted cron service). Vercel's built-in Cron Jobs call their paths with
GET, so they can't call these POST-only routes directly.

```bash
# hourly — abandoned-cart reminders
curl -fsS -X POST "https://<domain>/api/cart-recovery" -H "Authorization: Bearer $CART_RECOVERY_SECRET"

# daily — retention
curl -fsS -X POST "https://<domain>/api/maintenance" -H "Authorization: Bearer $MAINTENANCE_SECRET"
```

Crontab form (the times are the machine's time zone; the jobs themselves don't care when they run):

```cron
5 * * * *   curl -fsS -X POST "https://<domain>/api/cart-recovery" -H "Authorization: Bearer $CART_RECOVERY_SECRET" >/dev/null
30 3 * * *  curl -fsS -X POST "https://<domain>/api/maintenance"   -H "Authorization: Bearer $MAINTENANCE_SECRET"   >/dev/null
```

Running the cart job more often than hourly is harmless (it only claims what is due) but gains
nothing; running it less often only delays reminders. A missed run is caught up by the next one,
and a late run can never send two reminders back to back (each reminder waits for the gap after
the previous one — `minGapMinutes` in `src/lib/cart-recovery.ts`).

## 3. What the endpoints answer

`POST /api/cart-recovery`

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{ "ok": true, "stages": [{ "stage": 1, "claimed": 2, "sent": 2, "failed": 0, "more": false }, …] }` | One entry per reminder. `failed` sends were handed back to the queue (retried next run); `more: true` = the batch of 20 filled and the next run continues |
| 401 | `{ "error": "Unauthorized." }` | No or wrong bearer secret (and no admin session) |
| 503 | `{ "code": "recovery_not_configured" }` | `CART_RECOVERY_SECRET` or email not set — checked before any database work |
| 503 | `{ "code": "secret_mismatch" }` | The env secret isn't the one in `app_config.cart_recovery` |
| 503 | `{ "code": "migration_pending" }` | `13_abandoned_carts.sql` isn't applied |
| 400 | `{ "error": … }` | A bad `?stage=` / `?minAgeMinutes=` value |

`POST /api/maintenance` (WP-H): 200 `{ "ok": true, "ranAt", "deleted": { "rate_limit_hits", "assistant_order_lookups", "analytics_events", "assistant_sessions", "assistant_messages", "abandoned_carts", "finder_responses" }, "total" }`;
401 wrong/missing bearer; 503 unset secret, database secret mismatch or `22_retention.sql` missing.

The admin **Abandoned carts** tab has a **Send due reminders** button: the same job, authorised by
the admin's session instead of the secret (the secret and email must still be configured). It
runs the real schedule only — the test overrides below are ignored for it.

## 4. Testing the reminders (bearer secret only)

Two overrides are honoured **only** with the bearer secret:

- `?minAgeMinutes=0` — treat a checkout as abandoned immediately (instead of after 1 h / 24 h / 72 h);
- `?stage=N` — run only reminder N (1–3).

```bash
# 1. On the storefront: add something to the basket, open /checkout, type an email you can read
#    and a first name, wait 3 seconds (the autosave), then leave without ordering.
# 2. Send the first reminder now:
curl -sS -X POST "https://<domain>/api/cart-recovery?minAgeMinutes=0" -H "Authorization: Bearer $CART_RECOVERY_SECRET"
#    → stage 1: "claimed": 1, "sent": 1 — the email arrives with "Restore my basket" (/recover?token=…)
#      and "Stop basket reminders" (/recover/stop?token=…).
# 3. Run it again straight away:
curl -sS -X POST "https://<domain>/api/cart-recovery?minAgeMinutes=0" -H "Authorization: Bearer $CART_RECOVERY_SECRET"
#    → nothing is sent: reminder 1 is already stamped, and reminder 2 waits 23 hours after reminder 1
#      (the gap is not overridden).
# 4. Without the secret:
curl -sS -X POST "https://<domain>/api/cart-recovery"      # → 401
```

Other checks: placing an order with that email stops the reminders; "Stop basket reminders"
(after confirming) stops them for that address — also for any later basket; a shopper only ever
gets reminders about their most recent basket.

The queue, in the SQL editor:

```sql
SELECT recovery_stage, count(*) FROM public.abandoned_carts
 WHERE NOT converted AND NOT recovery_opted_out GROUP BY 1 ORDER BY 1;
```

## 5. Log lines worth alerting on

- `[cart-recovery] the database refused CART_RECOVERY_SECRET` — env and `app_config` differ.
- `[cart-recovery] could not release cart …` — a failed send could not be handed back (that cart
  loses one reminder).
- `[cart-recovery] stage N filled its batch` — more carts were due than one run sends.
- `[email] not configured — skipped …` / `[email] send failed — …` — mail isn't going out.
- `[maintenance] MAINTENANCE_SECRET is unset …` / `app_config 'maintenance' does not match …`.
- `… is missing — apply migration NN_….sql`.

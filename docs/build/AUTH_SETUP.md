# Auth setup — first deploy (Supabase)

What the owner (or whoever deploys) must set in the Supabase dashboard so sign-up, sign-in,
email confirmation and password reset work. Source: blueprint §18 "First deploy" step 1 and 5,
§3.2 (Supabase Auth gotchas), §9.13 (accounts), §14 lesson 44. Code: `src/app/(store)/signin`,
`src/app/(store)/reset-password`, `src/app/auth/callback/route.ts`, `src/components/account/**`.

Do these **before launch**. Skipping step 2 is the classic failure: sign-ups and password resets
silently stall.

---

## 1. Email sign-in with confirmation

Supabase → **Authentication → Sign In / Providers → Email**

- **Enable Email provider**: on.
- **Confirm email**: **on**. Guest orders are linked to an account only once its address is
  confirmed (`02_customers_and_auth.sql`), and the order/dashboard RLS trusts the verified email.
- **Secure email change**: leave on (the default).
- **Minimum password length**: **8** — the storefront forms ask for at least 8 characters.

## 2. Custom SMTP — before launch

Supabase's built-in mailer sends only a couple of emails per hour. Use the same provider as the
store's transactional email (Resend).

Supabase → **Authentication → Emails → SMTP Settings** → enable custom SMTP:

| Field | Value |
| --- | --- |
| Host | `smtp.resend.com` |
| Port | `465` (SSL) or `587` (STARTTLS) |
| Username | `resend` |
| Password | a Resend API key |
| Sender email | an address on the domain you verified in Resend (the same domain as `RESEND_FROM_EMAIL`) |
| Sender name | `Dock One Solutions` |

Then **Authentication → Rate Limits**: raise "emails sent per hour" to what the store needs.

## 3. Site URL and redirect URLs

Supabase → **Authentication → URL Configuration**

- **Site URL**: the storefront's origin — the same value as `NEXT_PUBLIC_SITE_URL`
  (e.g. `https://dockone.lk`; that domain is a placeholder until the real one is chosen).
- **Redirect URLs**: add
  - `https://<your-domain>/auth/callback` (production — any path on the Site URL's own host is
    accepted anyway);
  - `http://localhost:3000/**` for local development;
  - your preview-deployment pattern (for example `https://*-<team>.vercel.app/**`) if you test auth
    on previews.

The app builds every confirmation and reset link as
`${NEXT_PUBLIC_SITE_URL}/auth/callback?next=<where to go afterwards>`. So **set
`NEXT_PUBLIC_SITE_URL` in every environment** (`http://localhost:3000` locally) — otherwise the
links point at the production domain.

## 4. Branded email templates

Supabase → **Authentication → Emails → Templates**. Paste the file's whole content into the
template body and set the subject:

| Template | File | Subject |
| --- | --- | --- |
| Confirm signup | `supabase/email-templates/confirm-signup.html` | `Confirm your email — Dock One Solutions` |
| Reset password | `supabase/email-templates/reset-password.html` | `Reset your password — Dock One Solutions` |

Both use `{{ .ConfirmationURL }}` (keep it — it verifies the link, then lands on `/auth/callback`
with a one-time `?code=`) and `{{ .SiteURL }}`. They use the same frame as the store's own emails
(`src/lib/email/layout.ts`). The store does not offer magic links, invites or email changes, so the
other templates are not used.

## 5. Apply the migrations

Apply `supabase/migrations` in order (at least `01`–`11` for accounts: `02_customers_and_auth.sql`
provisions a `customers` row for every sign-up; `07`/`09` hold orders; `10_wishlists.sql` the saved
items). Verify with the SQL in each file's OPS NOTE.

## 6. Make the owner an admin

Admin access comes **only** from `customers.is_admin`, set in the SQL editor — never from sign-up
data (blueprint §6.2).

1. On the live site, open `/signin` → **Create account** with the owner's email, then open the
   confirmation email and confirm.
2. In the Supabase SQL editor:

   ```sql
   UPDATE public.customers SET is_admin = TRUE WHERE lower(email) = lower('<owner-email>');
   SELECT email, is_admin FROM public.customers WHERE is_admin;   -- the owner, and nobody else
   ```

3. Sign in at `/admin/signin`. The account menu on the storefront also shows "Admin panel" for
   that account (display only — every admin page and write re-checks on the server).

## 7. Check it end to end

Blueprint §16, phase 1 acceptance: "confirmation and reset links land signed in".

1. `/signin` → **Create account** → the form switches to "Confirm your email". The email arrives
   within a minute (if not: step 2). "Resend email" sends another.
2. Open the link **in the same browser** → you land signed in on your account page
   (`/customer/dashboard`, or where you were heading). Your first name shows in the account menu.
3. Open a confirmation link **in a different browser** → `/signin` says "Your email address is
   confirmed" — sign in there. (The one-time code only works in the browser that asked for it; the
   address is confirmed either way.)
4. Open an old or already-used link → `/signin` says "That link has expired or was already used".
5. Sign out, then **Forgot password?** → the page says a link was sent *if* an account exists (it
   never reveals whether one does). The link opens `/reset-password`; save a new password; sign in
   with it.
6. `/customer/dashboard` while signed out → redirected to `/signin?next=…`, and back to the
   dashboard after signing in.
7. Save a product with the heart while signed out, then sign in → it appears in `/wishlist` and in
   the dashboard's "Saved items", and stays there on another device.

## How the pieces fit (reference)

| Flow | Browser call | Lands on |
| --- | --- | --- |
| Sign in | `signInWithPassword` | `next` (default `/customer/dashboard`) — full page load so server pages see the session |
| Create account | `signUp` with `first_name` / `last_name` metadata and `emailRedirectTo` | "Confirm your email" state (or signed in straight away when confirmation is off) |
| Resend confirmation | `resend({ type: "signup" })` | — |
| Forgot password | `resetPasswordForEmail` with `redirectTo …/auth/callback?next=/reset-password` | `/reset-password` → `updateUser({ password })` |
| Email link | — | `/auth/callback` exchanges the code for a session (route handler), then `next` |
| Sign out | `signOut({ scope: "local" })` | this device only; per-person data in the browser is cleared |

`/signin?notice=…` only accepts the keys `confirmed`, `link_invalid`, `reset_link` and
`unavailable` — nothing else from the URL is ever shown.

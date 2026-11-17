# WhatsApp Business — setting it up (admin → WhatsApp)

The website talks to WhatsApp through **Meta's WhatsApp Cloud API**. You create a Meta app once,
then paste its keys into **admin → WhatsApp → Connect WhatsApp**. Nothing is entered on the server
or in Netlify. After that:

- customers' WhatsApp messages arrive in **admin → WhatsApp → Chats**;
- you and your staff reply from there;
- **WhatsApp** on an issued invoice sends the invoice PDF to the customer;
- if you switch it on, the store's **AI assistant** (the same one as on the website) answers
  customers on WhatsApp. It steps back in a chat for a few hours once a person has replied there.

Needs migration `54_whatsapp.sql` (see `supabase/MIGRATION_PLAN.md`). Allow about 30 minutes, plus
Meta's review time for the invoice template.

---

## Decide first: which number

The Cloud API uses **one phone number**. Two choices:

1. **A new number just for the API** (a spare SIM). This is the simplest option, and your current
   WhatsApp Business app number stays as it is.
2. **Your current WhatsApp Business app number.** Meta can connect a number that is already in the
   WhatsApp Business app ("coexistence": the app and the API share the number) where it is
   available. Otherwise the number has to leave the app before it can join the API. Check this in
   step 2 before you commit to it.

## 1. Create the Meta app

1. Go to **developers.facebook.com** and sign in with the Facebook account that manages the business.
   Open **My Apps → Create app**.
2. For the use case, choose **"Connect with customers through WhatsApp"**. Pick (or create) your
   **Meta Business portfolio** (business.facebook.com) and create the app.
3. In the app's left menu, open **WhatsApp → API setup**. Meta gives you a free **test number** you
   can use straight away. Two IDs appear on this page:
   - **Phone number ID** — the long number under the "From" number;
   - **WhatsApp Business Account ID**.

## 2. Add your real number

On **WhatsApp → API setup**, choose **Add phone number**. Enter the display name ("Dock One
Solutions"), your category, and the number. Then verify it with the SMS or voice code. When Meta asks
for a two-step verification PIN, choose six digits and keep them safe.

The **Phone number ID** of the new number is the one to use. Pick the number in the "From" list to
see it.

## 3. A permanent access token

The token on the API setup page expires after 24 hours. For the website, make a permanent one:

1. Open **business.facebook.com → Settings → Users → System users → Add**. Name it (for example
   "Website"), with the role **Admin**.
2. **Assign assets.** Under **Apps**, choose your app with full control. Under **WhatsApp accounts**,
   choose your WhatsApp account with full control.
3. Choose **Generate new token**, pick your app, and set expiry to **Never**. Tick these permissions:
   **whatsapp_business_messaging** and **whatsapp_business_management**. Copy the token (it starts
   with `EAA…`).

## 4. The app secret

In the Meta app: **App settings → Basic → App secret → Show**, and copy it. The website uses it to
check that incoming messages really come from Meta. Without it, no message is stored.

While you are on this page, set **Privacy policy URL** to `https://dockonesolutions.com/privacy`.
You need it to publish the app in step 7.

## 5. Paste the keys into the admin

Open **admin → WhatsApp → Connect WhatsApp → 1 · Meta app keys**:

| Field | Paste |
| --- | --- |
| Phone number ID | step 1 / 2 |
| WhatsApp Business Account ID | step 1 |
| Permanent access token | step 3 |
| App secret | step 4 |

Press **Save keys**, then **Test connection**. It should show your number and its verified name.
The token and the app secret are never shown again. To replace one, paste a new one into its box and
save.

## 6. The webhook (so messages arrive)

In the admin, **2 · Webhook** shows two values with copy buttons: the **Callback URL**
(`https://dockonesolutions.com/api/whatsapp/webhook`) and the **Verify token**.

In the Meta app: **WhatsApp → Configuration → Webhook → Edit**.

1. Paste the Callback URL and the Verify token.
2. Press **Verify and save**. Meta calls the website, and the website answers if the token matches.
3. Under **Webhook fields**, choose **Manage** and subscribe to **messages**.

Send a WhatsApp message to the number from your phone. It appears in **admin → WhatsApp → Chats**
within a few seconds. "Last message from Meta" under the webhook also updates.

## 7. Publish the app

While the app is in **Development** mode, Meta only delivers messages to and from people who have a
role on the app. Switch it to **Live** with the toggle at the top of the app dashboard. Meta asks for
the privacy policy URL from step 4 and an app icon.

## 8. The invoice template (for customers who haven't written lately)

WhatsApp's rule: a business can write freely to a customer only **within 24 hours of that customer's
last message**. After that, only an **approved template** can be sent. This is also how a new chat
is started.

To send invoices to anyone, any time, create one template:

1. Open **WhatsApp Manager** (business.facebook.com → WhatsApp accounts) and go to **Message
   templates → Create template**.
2. Set **Category** to *Utility*. Use the name **`invoice_pdf`** (lower case and underscores only)
   and the language **English**.
3. Set **Header** to *Document*.
4. For the **Body**, use your own wording with two placeholders, `{{1}}` for the customer's name and
   `{{2}}` for the invoice number. For example: *"Hello {{1}}, please find your invoice {{2}} from
   Dock One Solutions attached. Thank you for shopping with us."* Give sample values and submit.
5. When Meta approves it (usually minutes to a day), enter the name and language in **admin →
   WhatsApp → Settings → 4 · Invoice template** and save.

From then on, **WhatsApp** on an invoice sends a plain PDF with your message if the customer wrote
in the last 24 hours. Otherwise it sends this template with the PDF.

For other templates (for example a greeting to start a chat), create them the same way. Send them
from **Chats → New** or from a chat whose 24 hours have passed. The values for `{{1}}`, `{{2}}` …
go one per line.

## 9. AI replies

**Settings → 3 · AI replies → "Let the AI answer on WhatsApp".** It answers new **text** messages
using the website's catalogue, prices, stock, delivery and payment facts. It sends product links.
For order questions it sends the tracking page link (it never asks for order numbers or emails).

- When one of you replies in a chat, the AI waits for the hours set there (12 by default).
- Each chat has its own **"AI replies in this chat"** switch.
- It answers at most 30 messages an hour per number.
- It needs the same OpenAI key as the website's assistant (already set if the website chat works).

## 10. Staff

**Staff → a person → Edit access → WhatsApp:**

- **View** reads the chats.
- **Edit** also replies, starts chats with templates, opens customers' photos and files, and
  switches the AI off in a chat.

Staff with **Invoices → Edit** can send invoices on WhatsApp. The keys and settings stay the
owner's.

## Costs

Meta charges for **template messages** (business-initiated messages outside the 24-hour window) by
category and country. Replies inside the 24-hour window are free. See Meta's current WhatsApp
pricing page, and add a payment method in WhatsApp Manager before sending templates to customers.

## If something doesn't work

| What you see | What to do |
| --- | --- |
| Test connection: "Meta refused the access token" | The token was copied incompletely, or it expired (made on the API setup page instead of a system user). Make a permanent one (step 3). |
| Test connection: "doesn't have the WhatsApp permissions" | Regenerate the system-user token with both whatsapp_business_* permissions, and assign the WhatsApp account to the system user. |
| No messages arrive | Check that the app secret is saved (step 4), the webhook is verified and subscribed to **messages** (step 6), and the app is **Live** (step 7). |
| Sending fails: "isn't registered with the Cloud API" | Finish adding the number (step 2), including the two-step PIN. |
| Sending fails: "isn't on the test number's allowed list" | You are still on Meta's test number. Add your real number (step 2), or add the recipient under API setup → "To". |
| "only an approved template can be sent now" | The customer's last message is more than 24 hours old. Use the template (step 8). |

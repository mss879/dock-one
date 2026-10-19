# Dock One Solutions: guide to offers, promotions and category images

This guide is for the shop owner. It explains how to:

1. create offers (discount codes), run a flash sale and change the promotional content on the homepage, and
2. set up the pictures and look of each category (the stage image, the hero product cut-out and the scene).

Button and field names are written **in bold**, exactly as they appear in the admin panel.

---

## 1. Before you start

1. Go to **dockonesolutions.com/admin** and sign in with your admin account.
2. The menu on the left is grouped. You will use these items:
   - **Commerce → Discounts**: discount codes and how well they perform.
   - **Catalogue → Products**: product prices, compare-at prices, flags (New, Flash deal and so on) and cut-out images.
   - **Catalogue → Categories**: category names, taglines, stage images, hero products, scenes and order.
   - **Catalogue → Collections**: groups of products such as "Sale" or a brand.
   - **Content → Homepage**: hero slides, promo tiles, featured collections, the flash sale, new arrivals and content blocks.
3. **When do changes show on the website?**
   - Nothing changes until you press the save button (**Save slide**, **Save tile**, **Save**, **Save category** and so on). When the save works, a message confirms it and the website refreshes straight away.
   - If you see the message "Saved — storefront refresh delayed", your change **is** saved. The live site will catch up on its own within 5 minutes.
   - Discount codes are checked live at checkout, so a new or paused code takes effect immediately.
   - Scheduled hero slides appear or disappear within about two minutes of their start and end times.
4. **Images**: you can drag a picture onto an image box, or click **Upload …** (it says **Replace …** once there is a picture). JPG, PNG, WebP, AVIF and GIF are accepted. The admin converts every image to WebP in your browser before uploading it. Uploading alone does not put the picture on the site. You still have to save the form.
5. Each page in the admin shows a preview or a "Hidden now" note when something will not appear on the site, and it explains why.

---

## 2. Offers: discount codes

**Where:** Commerce → **Discounts**

A discount code is a word, such as `NEWYEAR10`, that a shopper types at checkout to get money off.

### Create a code

1. Click **New discount** (top right).
2. Fill in the form:
   - **Code**: what shoppers type, for example `AVURUDU15`. It must be 2–32 characters long and can use letters, numbers, `-` and `_`. It is saved in capitals, but shoppers can type it in any case. Two codes cannot share the same name.
   - **Name**: a name for your own reference, such as "Avurudu 2027". Shoppers never see it.
   - **Type**: choose **Percentage off** or **Fixed amount off (LKR)**.
   - **Percent off** / **Amount off**: the value. A percentage must be between 1 and 100. A fixed amount must be above 0.
   - **Minimum order** (optional): the smallest basket the code works on. This is the subtotal before the discount and before delivery. Leave it empty if there is no minimum.
   - **Usage limit** (optional): the total number of times the code can be used, counting every shopper. Leave it empty for unlimited use.
   - **Starts** / **Ends** (optional): the date and time the code starts and stops working. The end must be after the start. Leave them empty to have no time limit.
   - **Active**: if this is on, shoppers can use the code while it is within its dates.
   - **Assistant only**: see below.
3. Click **Create discount**.

### Read the list

Each code shows its **Discount**, **Minimum**, **Uses** (for example `3 / 50`), **Dates** and **Status**:

- **Live**: shoppers can use it now.
- **Scheduled**: its start time has not arrived yet.
- **Ended**: its end time has passed.
- **Used up**: it has reached its usage limit.
- **Paused**: you switched it off.

### Pause, resume or delete a code

Use the actions on each row:

- **Pause** stops a code for now. **Resume** turns it back on. This is the safe way to stop an offer.
- **Delete** removes the code for good. Orders that already used it keep their discount on record.

> **Good to know:** you cannot edit a code after you create it. To change the value, dates or limit, pause or delete the old code and create a new one.

### Assistant-only codes

The website has a shopping assistant (the tech desk chat). You can mark a code so that only the assistant is allowed to offer it to shoppers.

- When you create a code, switch on **Assistant only**. For an existing code, click **Assistant only** on its row.
- An assistant-only code **must have a usage limit**. If the code has none, a small window asks for a **Usage limit** before it saves.
- Click **Any channel** to remove the restriction.
- In the admin's words: "Only the shopping assistant may offer it (anyone who has the code can still use it)." In other words, the assistant decides when to offer the code, but anyone who has it can still type it in.

### Offer performance

Further down the Discounts page, the **Offer performance** table shows, for each code over a date range you pick:

- **Orders**: orders that used the code
- **Cancelled**: how many of those orders were cancelled
- **Revenue**: money from those orders
- **Discount given**: total discount given

Revenue and discount given leave out cancelled orders.

**Where it appears on the site:** at checkout, where the shopper enters the code.

**Not available today:** codes that only apply to certain products or categories, "free delivery" codes, "buy X get Y" offers and limits of one use per customer. A code always applies to the whole order subtotal.

---

## 3. Flash deals (flash sale)

A flash sale is a homepage section, "Flash deals", with a live countdown and up to 6 products. There is **one** flash sale at a time, and it has a real end time.

### Step 1: set the sale's end time

**Where:** Content → **Homepage** → the **Flash sale** tab

1. Optionally, set a **Section heading**. If you leave it empty, the heading is "Flash deals".
2. Set **Ends at**: the date and time (Sri Lanka time) the sale finishes.
3. Click **Save flash sale**.

The status line then shows **Live until …**, **Ended**, or **Not running — the section is hidden**.

- With no end time, or once the end time has passed, the section is hidden on the homepage automatically.
- To stop a sale early, click **Clear** next to **Ends at** and save.
- There is no "starts at" setting. The sale is live from the moment you save a future end time.

### Step 2: choose the products

Use either of these two places:

- **Same page**, under **Flash-deal products**: search for a product and switch on its **Flash deal** toggle. Switch **Flash deals only** off to see all your products. Each change saves immediately.
- **Or** go to Catalogue → **Products**, open a product, and under **Merchandising** switch on **Flash deal**.

### Step 3: show the "was" price (struck through)

The flash sale does **not** change prices by itself. To show a saving:

1. Go to Catalogue → **Products**, open the product, and go to **Variants**.
2. Set **Price** to the sale price.
3. Set **Compare-at price** to the old, higher price. It is shown struck through next to the price. If it is not higher than the price, it is not shown.
4. Save the product. After the sale, remember to put the prices back.

**Where it appears on the site:**

- The **Flash deals** section on the homepage, with a countdown and up to **6** products. Products marked **Featured** come first, then the rest by product **Sort order**.
- The **Deals** page (`/shop?filter=deals`) lists every flash-deal product. The header menu links to it ("Deals"), and so does the footer ("Flash deals").
- The **View all deals** link on the homepage section goes to that page.

> **Good to know:** the Deals page lists products flagged **Flash deal** even when no sale is running. It only shows the countdown while an end time is set. Switch the flags off when a sale is over.

---

## 4. Promotional content on the homepage

**Where:** Content → **Homepage**. The tabs along the top are **Hero slides**, **Promo tiles**, **Collections**, **Flash sale**, **New arrivals** and **Content blocks**. The **View homepage** button opens the live site.

### 4.1 Hero slides (the big slider at the top)

1. Open the **Hero slides** tab and click **New slide**. To change an existing slide, click it or use **Edit**.
2. The editor shows a live **Preview** at the top. Fill in:
   - **Active**: inactive slides are kept but never shown.
   - **Desktop image**: shown on screens from 1024 px wide. The admin's advice: *"Best at 2400 × 1100 px (about 2.2 : 1) with the left half kept clear for the text — the right edge always shows."* You can also type the path of an image already on the site in **Desktop image path**, such as `/images/hero/opening.webp`.
   - **Mobile image** (optional): for phones and portrait tablets, shown as a band under the text. The admin's advice: *"Best at 1200 × 700 px (about 1.7 : 1) with the product in the middle; no text needed in the image."* If you leave it empty, phones get the desktop image. You must add the desktop image first.
   - **Fallback scene**: the background used when there is no image. Choose **Night (dark)**, **Paper (light)**, **Lime** or **Violet**.
   - **Text colour**: choose **Light text (dark slide)** or **Dark text (light slide)**.
   - **Background**: a colour code such as `#0b0b0c`. Match it to the edge colour of your image.
   - **Chip** (up to 40 characters): the highlighted label.
   - **Eyebrow** (up to 80 characters): the small line after "/01 —".
   - **Title** (required, up to 200 characters): starting a new line in the box starts a new line on the slide.
   - **Text** (up to 500 characters).
   - **Button label** + **Button link**, and **Second link label** + **Second link**. Each button needs both a label and a link. See *Choosing a link* below.
   - **Read-out lines**: up to 6 short lines (40 characters each) for the small decorative box, shown on desktop only. Press Enter after each line.
   - **Show from** / **Show until** (optional): the slide's schedule. Leave them empty to show the slide straight away with no end.
3. Click **Save slide**.

To manage existing slides:

- Change the order with the up and down arrows, then click **Save order**. **Undo** cancels your reordering.
- Use **Hide** or **Show** to take a slide down for now. **Delete** removes it for good.

**Where it appears:** the large slider at the very top of the homepage. If no slide is live, the slider is hidden.

**Formatting help** (also available in the editor): `{lime:word}` or `{violet:word}` colours a word. `{free_delivery_threshold}` inserts your free-delivery amount from Store settings. `{returns_window_days}` inserts your returns window. A line that uses one of these is hidden while that setting is off. A price written as `Rs. 12,900` follows the shopper's display currency.

### 4.2 Promo tiles (the four-tile block under the categories)

There are four fixed slots:

- **Slot 1 — tall, left (widest)**
- **Slot 2 — tall, middle**
- **Slot 3 — wide, top right**
- **Slot 4 — wide, bottom right**

To fill a slot:

1. On the **Promo tiles** tab, click **Fill slot** (or **Edit** if the slot already has a tile).
2. Fill in:
   - **Active**
   - **Tile image**: keep the left part clear for the text.
   - **Fallback scene**, **Text colour** and **Background**: these work the same way as on hero slides.
   - **Image position** (optional): which part of the image stays in view, for example `85% bottom` or `right 78%`.
   - **Eyebrow** (up to 40 characters)
   - **Title lines**: 1–4 lines of up to 40 characters each.
   - **Text** (up to 160 characters): hidden on phones in the two wide slots.
   - **Button label**
   - **Tile link** (required): the whole tile links to this page.
3. Click **Save tile**.

To remove a tile, **Clear slot** deletes it. To hide it for a while instead, edit the tile and switch **Active** off.

**Where it appears:** on the homepage, just below "Shop by category".

- All four tiles live: the four-tile layout.
- Fewer than four: an even row of tiles.
- None: the section is hidden.

> **Not available today:** promo tiles have no start or end date. Switch them on and off by hand.

### 4.3 Choosing a link (hero buttons and promo tiles)

Every link field has a drop-down with four choices:

- **Collection**: pick a collection, such as a "Sale" collection.
- **Category**: opens the shop filtered to that category.
- **Store page**: Shop — all products, Deals, New arrivals, All collections, Homepage — categories, Homepage — flash deals, or Product finder.
- **Custom address**: a site path such as `/shop?category=laptops`, or a full `https://` address.

The admin warns you if you pick a collection or category that is switched off.

### 4.4 Collections (themed groups of products)

**Step A: create the collection.** Go to Catalogue → **Collections** and click **New collection**.

1. Fill in the details:
   - **Title**
   - **Slug**: becomes the web address.
   - **Tile line**: the short line under the title on the homepage tile.
   - **Kind**
   - **Description**
   - **Sort order**
   - **Active**
2. **Cover image**: used on the collection's own page.
3. Under **Products**, choose **Hand-picked** (you choose the products and their order) or **Automatic** (rules choose the products, and the list keeps itself up to date).
4. Under **Homepage**, switch on **Featured on the homepage**. Then use **Find a tile product** to pick the **two** products whose cut-outs appear on the tile.

**Step B: arrange the homepage row.** Go to Content → **Homepage** → the **Collections** tab.

1. Switch collections on or off for the homepage, up to 12.
2. Order them with the arrows.
3. Click **Save**.

You may see two warnings: "Tile art incomplete" means fewer than two tile products are set, and "Hidden collection — not shown until active" means the collection is switched off.

**Where it appears:** the "Featured collections" row on the homepage, each collection's own page, and the All collections page (`/collections`). If no collection is featured, the row is hidden.

**Tip for a sale:** create a "Sale" collection, add the products, then point a hero slide button or a promo tile at it with **Collection → Sale**.

### 4.5 New arrivals

On the **New arrivals** tab:

1. **New arrivals feature**: the big violet tile.
   1. Click **Add content**, then **Choose product**.
   2. Fill in a **Title** (up to 60 characters) and a **Kicker** (the lime line, up to 60 characters).
   3. Click **Save**.
   4. **Remove** deletes the tile, and the newest products fill the row.
2. **Newest products**: the row shows the four newest active products flagged **New**. To flag one, go to Catalogue → **Products**, open the product, and under **Merchandising** switch on **New**.

> **Good to know:** the feature tile is linked to the product's slug. If you change that product's slug, choose the product here again.

**Where it appears:** the "New arrivals" section of the homepage, and the **New** page (`/shop?filter=new`).

### 4.6 Content blocks

The **Content blocks** tab has five smaller sections. Each one has **Save**, **Discard changes** and **Remove**, and removing a block hides that section.

- **Hero perks**: up to 4 short perks in the strip under the hero slider (desktop only).
- **Trust row**: up to 6 promises with animated icons, under Best sellers.
- **Order your way**: a heading, text, up to 4 "ways to order", and a **Top cut-out** and **Bottom cut-out** product. The WhatsApp button and the hotline come from Store settings.
- **Store status**: up to 6 label/value rows with a bar, plus a **Banner** line, shown next to the newsletter.
- **Testimonial**: a real customer quote, used only when no review is featured. A featured approved review (Catalogue → Reviews) always takes its place. Only use words a real customer gave you, with their permission.

### 4.7 Other product flags (Catalogue → Products → Merchandising)

- **New**: lists the product in New arrivals (newest first).
- **Best seller**: tops up the Best sellers row after real sales. The row is ranked by real sales over the last 90 days.
- **Featured**: puts the product first in the shop's default "Featured" sort, and first among the flash deals.
- **Flash deal**: see section 3.
- **Sort order**: lower numbers come first.

---

## 5. Category images and look

**Where:** Catalogue → **Categories**. Click a category, or click **New category**.

Each category card on the homepage is built in three layers:

1. **Stage image**: the photographic background.
2. **Hero product cut-out**: a product picture with no background that "breaks out" of the top of the card.
3. **Scene**: a coloured backdrop used when there is no stage image, or while the image loads.

### 5.1 Details

- **Name**: shown in the menu, on the card and on the category page.
- **Slug**: the category's web address and id. It is filled in from the name and uses lower-case letters, numbers and hyphens. Changing it later changes the category's web address, and its products follow automatically. Automatic collections with a rule on the old slug must be updated by hand. **It also affects the header menu group** (see 5.5).
- **Tagline**: the short line on the category card and under the name on the category page.
- **Description**
- **Scene**: choose **Night (dark stage)**, **Paper (light stage)**, **Lime** or **Violet**. The light scenes (Paper, Lime) use dark text shading on the card.
- **Sort order**: lower numbers come first, in the menu and on the homepage.
- **Active**: off hides the category from the menu, the homepage cards and the filters. Its products stay on sale.

### 5.2 Stage image

1. In the **Stage image** section, click **Upload stage image** or drag a picture in.
2. Click **Save category** (or **Create category** for a new one).

The image fills the card and is cropped to fit. Keep the main interest near the middle, because the product cut-out sits in front of it. The admin does not state a recommended size for stage images.

### 5.3 Hero product (the cut-out)

The cut-out itself belongs to a **product**, not to the category.

1. **First, give the product a cut-out.** Go to Catalogue → **Products**, open the product, find the **Media** section, and upload a **Cut-out**. The admin describes it as *"A transparent PNG or WebP of the product alone — used by category pop-outs, collection tiles and banners."* Save the product.
2. **Then pick it for the category.** In the category editor, under **Hero product**, use **Find a product in this category** and click **Use as hero**.
   - You can only choose a product that is already in this category, so create the category and add products to it first.
   - If the product has no cut-out yet, the admin says "No cut-out yet — add one in the product's Media section."
   - **Clear** removes the hero product.
3. Save the category.

### 5.4 Where it appears

- **Homepage → "Shop by category"** cards: stage image (or scene), name, tagline, the real product count, and the cut-out.
- **The category page** (`/shop?category=…`): a banner with the same stage image (or scene), name, tagline and cut-out.
- **The header menu, footer and /shop filters**: the category name. The menu also shows the tagline.

> **Good to know:**
> - The nine existing categories (laptops, storage, keyboards, mice, monitors, audio, power-charging, cameras, components) have built-in pictures. These are used whenever you leave the stage image empty, or when the hero product has no cut-out.
> - A **new** category has no built-in pictures. It shows the **Scene** until you upload a stage image, and it shows no cut-out until its hero product has one.
> - The hero product must be **active** for its cut-out to show.
> - The angle and size of each cut-out on its card are set in code for the nine existing categories. New categories get a standard pose.

### 5.5 Header menu groups (needs a developer)

On desktop, the header menu groups categories into **Computing**, **Accessories** and **Cameras**. The grouping is set in the website's code by category slug. You cannot change it in the admin.

- A **new** category, or one whose **slug** you change, appears automatically under a group called **More**, so it never disappears from the menu.
- To move it into Computing, Accessories or Cameras, ask your developer to add its slug to the menu groups (in `src/components/layout/nav.ts`).
- Within each group, categories follow your **Sort order**.

### 5.6 Deleting a category

Use **Delete** on the category's row. The database refuses to delete a category that still has products. Move the products to another category first, or switch the category's **Active** off instead.

---

## 6. Quick reference: what is NOT possible in the admin today

- Editing an existing discount code. Pause or delete it, then create a new one.
- Discount codes for specific products or categories, free-delivery codes, or limits of one use per customer.
- A start time for the flash sale (it starts when you save the end time), or more than one flash sale at once.
- Automatic sale prices. Set **Price** and **Compare-at price** on each product by hand, and put them back afterwards.
- Schedules for promo tiles (hero slides **can** be scheduled).
- Moving a category into a different header menu group (needs a developer, see 5.5).
- Changing the pose (size and tilt) of a category's cut-out on its card.

# Instagram on the homepage — setting it up

The homepage can show the store's latest Instagram posts in a **"Follow us on Instagram"** strip,
like laptop.lk's. Each post opens on Instagram. You paste an Instagram access token into **admin →
Homepage & navbar → Instagram**, and the website does the rest:

- it fetches the latest posts when you press **Refresh now**;
- it also refreshes by itself about twice a day while someone with Homepage access has the admin open;
- it renews the token as it goes (an Instagram token lasts 60 days, and each renewal restarts the 60).

Needs migration `55_instagram_feed.sql`. Nothing is entered on the server or in Netlify.

## 1. A professional Instagram account

The store's Instagram must be a **Business** or **Creator** account. In the Instagram app, open
**Settings → Account type and tools → Switch to professional account**. It is free, and it doesn't
change what followers see.

## 2. A Meta app with Instagram Login

1. Go to **developers.facebook.com → My Apps → Create app**.
2. Choose the use case for **Instagram** ("Manage messaging & content on Instagram"), then create
   the app.
3. Open **Instagram → API setup with Instagram login**.
4. Under **Generate access tokens**, choose **Add account** and sign in with the store's Instagram
   account. Accept the permission it asks for (**instagram_business_basic** is the only one needed;
   the website only reads posts).
   - If Meta says the account needs a role on the app, add it under **App roles → Roles →
     Instagram testers**. Then accept the invite in Instagram: **Settings → Website permissions →
     Apps and websites → Tester invites**.
5. Choose **Generate token** next to the account and copy it (it starts with `IG…`).

## 3. Paste it into the admin

**admin → Homepage & navbar → Instagram**:

1. Paste the token and press **Save token**. Saving also switches the strip on.
2. Press **Refresh now**. The latest posts appear as small squares in the admin.
3. Open the homepage. "Follow us on Instagram" sits above the newsletter, with a link to the profile.

Only the owner can save or replace the token, and it is never shown again. **Disconnect** removes it,
and **Show on the homepage** hides the strip without removing the token.

## Good to know

- The token renews itself only while the admin is used at least once every 60 days. If it lapses, the
  panel shows the error from Instagram. Generate a new token (step 2.5) and paste it.
- Instagram's picture links expire after a few days. The automatic refresh replaces them. If the
  admin hasn't been opened for a while, press **Refresh now**.
- Videos show their cover picture with a play mark. Albums show their first picture.
- Up to 12 posts are kept, newest first.

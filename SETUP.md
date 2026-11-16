# Setting up Karen's List

Three parts, done once: the website, the reminder server, and your iPhone.

## 1. Turn on the website (GitHub Pages)

1. On GitHub, open the **Todo** repository, then **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Pick the **main** branch and the **/ (root)** folder, then **Save**.
4. After a minute or two the page shows your address: **https://ktocatly.github.io/Todo/**

Free GitHub Pages needs the repository to be public. That makes the page's code visible, but not your to-dos: they live on your reminder server, behind your key.

The site works right away. Without the reminder server, reminders only chime while the page is open.

## 2. Set up the reminder server (Cloudflare, free)

The reminder server holds your list and sends the notifications. It runs on Cloudflare's free plan.

**The easy way:** create a free account at cloudflare.com, then ask Claude to deploy it. Claude will ask for a Cloudflare API token through a secure form (never paste it into the chat). To make the token: in Cloudflare, go to **My Profile → API Tokens → Create Token**, use the **Edit Cloudflare Workers** template, and add the permission **Account → D1 → Edit** if it isn't listed. Claude then deploys the server, fills in its address in `config.js`, and gives you your key.

**Doing it yourself** (needs Node.js on a computer), from the `worker` folder:

```sh
npm install
npx wrangler login
npx wrangler d1 create karens-list            # copy the database_id it prints into wrangler.toml
npx wrangler d1 execute karens-list --remote --file=schema.sql
node scripts/generate-keys.mjs                # prints VAPID_PRIVATE_JWK and API_KEY
npx wrangler secret put VAPID_PRIVATE_JWK     # paste the first value
npx wrangler secret put API_KEY               # paste the second value
npx wrangler deploy                           # prints the server address, ending in workers.dev
```

Put the server address in `config.js` as `serverUrl`, and keep the API key somewhere safe, like your password manager. You'll paste it once on each device.

## 3. On your iPhone

iPhones only allow website notifications for sites added to the home screen (iOS 16.4 or newer).

1. Open **https://ktocatly.github.io/Todo/** in **Safari**.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Open **Karen's List** from your home screen (not from Safari).
4. Tap **Get notifications on your phone**, paste your key, and tap **Connect**.
5. Tap **Turn on notifications**, then **Allow**.
6. Tap **Send a test**. A notification from Karen's List should arrive within a few seconds.

On a computer, open the same address and connect with the same key to see the same list.

## How reminders behave

- **Once:** one notification at the date and time you picked.
- **Every day:** a notification at that time each day, in your time zone, until you check the to-do off.
- Tapping a notification opens Karen's List with the reminder showing, so you can check it off or snooze it for 10 minutes.
- The server checks once a minute, so a notification can arrive up to a minute after its time.

## Files

- `index.html` is Karen's List. `illustrated.html` is the earlier illustrated version.
- `sw.js` shows notifications on the phone. `manifest.webmanifest` and `assets/icon-*.png` make it a home-screen app.
- `config.js` holds the reminder server address.
- `worker/` is the reminder server. Run `node test/test.mjs` inside it to test it.

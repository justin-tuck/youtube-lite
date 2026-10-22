# YouTube Lite

A small, distraction-free page for following the YouTube creators you care about. It shows their latest videos and nothing else: no recommendations, Shorts, comments, or ads.

It's plain HTML, CSS, and JavaScript. There is no build step, no npm, and no server.

## Why

YouTube is built to keep you watching. This is the opposite: one calm page that lists new uploads from a short list of channels, marks what's new, and sends you to YouTube only when you pick something.

## Use it

1. Download or clone this repo.
2. Open `index.html` in your browser. Double-clicking it works.
3. (Recommended) Add a free YouTube API key. See [Getting an API key](#getting-an-api-key) below.
4. Click **+ Add creator** and paste a channel ID (starts with `UC`), a channel URL, or an `@handle`.
5. Click **Refresh** to load videos.

Everything is saved in your browser's localStorage. Use **Manage → Backup** to export or import your list as JSON, for example to move between browsers.

## Features

- Creators grouped into categories. A creator can be in several, or none.
- Videos sorted newest first, with a **New** badge for unseen uploads from the last 7 days.
- Mark videos seen one at a time, or mark everything in a category or creator as seen. Opening a video also marks it seen.
- Shorts are left out.
- Videos open on youtube.com in a new tab. Nothing is embedded or autoplayed.
- Light and dark themes follow your system setting. It works on narrow windows too.

## How videos are fetched

Each channel has a public RSS feed, but browsers block pages opened from `file://` from reading it directly (CORS). The app has two ways around that:

| Method | Setup | Tradeoffs |
|---|---|---|
| **YouTube Data API key** (recommended) | A free key from Google. See below. | Reliable, and @handle lookups work. The free quota is far more than this app needs. |
| **Public CORS proxies** (default, no key) | None. | Free third-party proxies are often down or rate-limited, and their operators can see your IP and the channels you follow. @handle lookups can fail, in which case paste the channel ID instead. |

You can also set your own proxy URL under **Manage → Fetching**, for example a small Cloudflare Worker. Use `{url}` where the feed address goes.

Failures are shown per creator, so one bad fetch doesn't break the page.

## Getting an API key

It's free, and you don't need to add a credit card. The YouTube Data API gives 10,000 units per day. This app uses about 1 unit per creator per refresh, so 30 creators refreshed 20 times a day is about 600 units. Going over the limit just pauses requests until the daily reset. You are never charged.

1. Go to <https://console.cloud.google.com/> and sign in with a Google account.
2. Use the project dropdown at the top to create a **New project** (any name), then select it.
3. Go to **APIs & Services → Library**, search for **YouTube Data API v3**, and click **Enable**.
4. Go to **APIs & Services → Credentials → Create credentials → API key**, and copy the key.
5. Click the new key to edit it:
   - Under **API restrictions**, choose **Restrict key** and tick only **YouTube Data API v3**. (If it's missing from the list, the API isn't enabled yet. Do step 3 first.)
   - Leave **Application restrictions** set to **None**. Pages opened from `file://` don't send a website address, so a "Websites" restriction would block the app.
   - Click **Save**. Changes can take a few minutes to apply.
6. In the app, open **Manage → Fetching**, paste the key, then click **Refresh**.

## Privacy and security

- **Use your own key, and don't share it.** Everyone who uses the app should create their own. A shared key means sharing one quota, and anyone holding it can use it.
- **Never put your key in the code or commit it.** The app stores it only in your browser's localStorage. If a key ever ends up in a commit, delete it in Google Cloud Console and create a new one. Removing it from the file isn't enough, because git history keeps it.
- **Restrict the key to YouTube Data API v3** (step 5 above). Then, even if it leaked, it couldn't be used for anything else on your Google account.
- **Your data stays in your browser.** Your creators, categories, and seen history are never uploaded anywhere. Only the feed requests themselves go to Google or to the proxy.
- **Exports contain no settings.** Backup files hold your creators, categories, and seen history, never your API key or proxy setting. Importing someone else's file can't change your settings.
- **Everything shown is treated as text.** Titles and names from feeds or imported files are escaped before display. Video links are always built as `youtube.com/watch?v=<id>`, and imported channel links must point to youtube.com.

## Sharing creator lists

You can send a friend your exported JSON file and they can load it with **Manage → Backup → Import JSON**. Importing **replaces** their current creators and categories (their API key and proxy setting are kept). The file also includes which videos you've watched.

## Troubleshooting

- **Something looks out of date after an update.** Browsers can cache `app.js` for local files. Press **Ctrl+F5** (or **Cmd+Shift+R** on a Mac) to reload.
- **A creator shows ⚠.** Hover over it to see the error. Without an API key this is usually a proxy being down. Try **Refresh** later or add a key.
- **Lost everything after clearing browser data.** Clearing site data wipes localStorage. Import your last backup and paste your API key in again.

## Files

- `index.html`: page structure and dialogs
- `style.css`: styles, including dark mode
- `app.js`: all the logic (storage, fetching, rendering)

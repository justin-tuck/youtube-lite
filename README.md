# YouTube Lite

A small, distraction-free page for following the YouTube creators you care about. It shows their latest videos and nothing else: no recommendations, Shorts, comments, or ads.

It's plain HTML, CSS, and JavaScript. There is no build step, no npm, and no server.

## Why

YouTube is built to keep you watching. This is the opposite: one calm page that lists new uploads from a short list of channels, marks what's new, and sends you to YouTube only when you pick something.

## Use it

1. Download or clone this repo.
2. Open `index.html` in your browser. Double-clicking it works.
3. Click **+ Add creator** and paste a channel ID (starts with `UC`), a channel URL, or an `@handle`.
4. Click **Refresh** to load videos.

Everything is saved in your browser's localStorage. Use **Manage → Backup** to export or import your data as JSON, for example to move between browsers.

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
| **YouTube Data API key** (recommended) | Free key from Google Cloud Console with YouTube Data API v3 enabled. Paste it in **Manage → Fetching**. | Reliable, and @handle lookups work. The free quota (10,000 units/day) is far more than this app needs. |
| **Public CORS proxies** (default, no key) | None. | Free third-party proxies are often down or rate-limited, and their operators can see your IP and the channels you follow. @handle lookups can fail, in which case paste the channel ID instead. |

You can also set your own proxy URL under **Manage → Fetching**, for example a small Cloudflare Worker. Use `{url}` where the feed address goes.

Failures are shown per creator, so one bad fetch doesn't break the page.

## Privacy and security

- Your creators, categories, and seen history never leave your browser, except that the proxy or Google receives the feed requests the app makes.
- Your API key is stored only in your browser's localStorage. It is not in the code and is not included in exports.
- Restrict your key to **YouTube Data API v3** in Google Cloud Console.
- Proxy responses are treated as plain text and escaped before display, and video links are always built as `youtube.com/watch?v=<id>` by the app itself.

## Files

- `index.html`: page structure and dialogs
- `style.css`: styles, including dark mode
- `app.js`: all the logic (storage, fetching, rendering)

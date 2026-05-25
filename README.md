# PinReel Helper

A small browser extension that reads media URLs from Pinterest pages **you are already viewing** and posts them to an endpoint **you configure**. Local-first: every capture is saved to the extension's IndexedDB. Sending to a remote endpoint is opt-in.

This project is independent. It is not affiliated with Pinterest. It works against any backend that implements the contract documented in [`API.md`](./API.md).

## What it does

- On `pinterest.com` pages you load yourself, the extension reads the media URLs that Pinterest's own page already loaded into your browser (videos, animated images, carousel slides).
- It saves them to local IndexedDB inside the extension.
- If you've configured an endpoint and turned on **Sync**, it also POSTs them to your endpoint.
- It can also capture a screenshot region of any webpage and POST that to your endpoint as a single image.
- It has a **Queue** mode: it can ask your endpoint "which pins do you want me to look at?" and process them one at a time (you decide when).

## What it does NOT do

- It does not run on its own. Every action requires an explicit user click in the popup.
- It does not write to Pinterest. No likes, saves, follows, comments, or board edits.
- It does not share captures with any third party. Captures stay local unless you turn on Sync to a destination you chose yourself.
- It does not include any analytics, tracking, or telemetry.

## Install

### Firefox
The recommended install path. Available from `addons.mozilla.org` (link to follow).

### Chrome / Chromium
1. Clone or download this repo.
2. Visit `chrome://extensions/`.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked**.
5. Select this folder.

Manual install gives you the version in the repo. Updates require re-loading the folder.

## Configure

1. Open the popup (toolbar icon).
2. **Settings tab** → paste your endpoint base URL and Bearer token.
3. Toggle **Sync captures to endpoint** if you want them sent automatically.
4. Adjust per-pin delay and daily cap to your taste (defaults are conservative).
5. **Save**.

The endpoint must implement [`API.md`](./API.md). One example is `https://www.moodly.design/api/external` — the helper does not need it specifically, it's just one of multiple destinations the contract supports.

## Use

- **Capture tab** — pick a destination canvas, click **Capture a region of this page**, drag a rectangle. The cropped image goes to your endpoint.
- **Queue tab** — pull the list of pending pins from your endpoint, then click **Process queue**. The extension visits each pin's Pinterest URL briefly to source the animated URL. Conservative throttle (default 12s ± 3s per pin, 75s pause every 15 pins). You can cancel at any time.

## Disclaimers

Please read [`DISCLAIMER.md`](./DISCLAIMER.md). The short version: you, the user, are responsible for using this in line with the Terms of Service of the sites you visit.

## License

MIT. See [`LICENSE`](./LICENSE).

# Disclaimer

PinReel Helper is a tool you install and operate in your own browser. It only acts when you explicitly tell it to.

## You are responsible for how you use it

The websites you visit have their own Terms of Service. Pinterest's user terms in particular prohibit automated access to Pinterest in ways that go beyond personal, individual use. This extension processes pin pages only when you click a button in its popup — it is not a bot or a scraper. But it is **possible** to use it in ways that look automated to Pinterest (e.g. enabling Sync and walking thousands of pins in a short window).

The defaults are conservative: a 12 second delay between pin loads with random jitter, a 75 second pause every 15 pins, a 200-pin per-session cap and a 500-pin per-day cap. You can adjust those in Settings; if you raise them aggressively, please understand you are using your own account at your own risk.

If Pinterest (or any other site you visit) restricts your account because of your usage of this tool, the authors of this extension are not responsible.

## What this extension does not do

- It does not include analytics, telemetry or any kind of phone-home.
- It does not log or transmit any data unless you have configured an endpoint and turned on Sync.
- It does not access Pinterest in any way except by acting in pages you yourself have loaded in your browser.
- It does not run on `pinterest.com` unless you visit it; the content script is only loaded on that origin.

## Open source

The code is MIT-licensed and lives at `https://github.com/javigildd/pinreel_helper`. You can read every line, fork it, change it, run a build of your own.

## No warranty

See [`LICENSE`](./LICENSE).

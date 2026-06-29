# Luna Chat — training guides

Two PDF training guides for going live with Luna Chat.

| Guide | Audience | Covers |
|---|---|---|
| **Luna-Chat-User-Guide.pdf** | Clients (travel‑business admins &amp; chat agents) | Widget setup wizard, Luna Brain, the agent dashboard, Luna Copilot, file sharing, WhatsApp, ratings/transcripts/translation, and a go‑live checklist. |
| **Luna-Chat-Staff-Guide.pdf** | Travelgenix account managers | A plain‑English, jargon‑free, six‑step walkthrough for getting a client live: create the client, send the welcome pack, install the widget, brand it, seed starter knowledge, test, go live — plus simple "if something doesn't look right" fixes. Deliberately non‑technical (no servers, keys or back‑end set‑up — those are already handled for every client). |

Both are illustrated with real screenshots captured from the live Luna pages in this repo (`public/setup.html`, `public/onboard.html`, `public/global-brain.html`, `public/luna-brain.html`, `public/dashboard.html`, `public/showcase.html`).

## Regenerating the PDFs

The guides are built from plain HTML + CSS in `source/` and rendered to PDF with headless Chromium.

```bash
cd docs/training-guides/source
node render.js   # needs Playwright's Chromium available
```

To refresh the screenshots, serve `public/` locally and re‑capture the pages, then drop the new PNGs into `source/img/` and re‑run `render.js`. Edit the `.html` files for copy changes and `style.css` for styling.

UK English throughout; Luna / Travelgenix branding.

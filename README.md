# luna-chat-endpoint

Luna Chat: the widget, the agent dashboard and the serverless API behind them.
Deployed on Vercel at `https://chat.travelify.io`.

Run the tests with `npm test`. They have no dev dependencies and need no
network, so they run on a bare checkout. CI runs them on every pull request and
every push to `main`.

## Secrets

Every value lives in Vercel environment variables. Nothing is checked in, and
`.gitignore` keeps a local `.env` out of the repo.

| Variable | What it opens |
| --- | --- |
| `AIRTABLE_KEY` | the client, conversation and knowledge bases |
| `ANTHROPIC_API_KEY` | Luna's replies |
| `ABLY_KEY` | live chat channels (the root key never leaves the server) |
| `ADMIN_PASSWORD` | `/onboard.html` and `/global-brain.html`, typed by a human |
| `LUNA_PROVISION_PASS` | `/api/clients` only, for Client Control |
| `SENDGRID_API_KEY` | transcript and lead emails |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | rate limiting and the health monitor state |
| `TG_STAFF_DOMAINS` | who counts as Travelgenix staff (defaults are built in) |

### About the two admin secrets

`/api/clients` has two callers that are nothing alike: a person typing the admin
password into `/onboard.html`, and Client Control calling machine to machine when
Luna Chat is switched on for a client. Client Control stores its copy in a second
Vercel project (`tg-widgets`, as `LUNA_CHAT_ADMIN_PASS`).

While both used `ADMIN_PASSWORD`, that stored copy also unlocked
`/api/global-brain`, the review screen for the shared knowledge base that answers
for every client. Creating a client and rewriting what Luna tells the world are
not the same privilege, so they no longer share a key:

- `/api/clients` accepts **either** `ADMIN_PASSWORD` or `LUNA_PROVISION_PASS`
- `/api/global-brain` accepts `ADMIN_PASSWORD` **only**

**To finish the split** (one job, about two minutes):

1. Generate a new random value, for example `openssl rand -base64 32`.
2. In the **luna-chat-endpoint** Vercel project, add `LUNA_PROVISION_PASS` set to
   that value. Redeploy.
3. In the **tg-widgets** Vercel project, change `LUNA_CHAT_ADMIN_PASS` to the same
   value. Redeploy.

Do step 2 first and nothing breaks in between: provisioning accepts both until
step 3 lands. Until step 2 is done, `/api/clients` logs a reminder on every call.

## Search links and the geo table

Every search link Luna builds is corrected server side before the visitor sees
it, so a Luna search covers the same ground as the same search on the site.
The site sends Travelify a curated centre point, a per-destination radius and
Travelify's own airport grouping (GR1 for Crete, AE1 for Dubai). The model
still names the place; `lib/geo-resolver.js` swaps in the site's `lat`, `lng`,
`rad` and `dst` whenever the `loc` it wrote matches a row in the table.

- **Radius is in miles.** The deeplink's `rad` takes miles, and so does the
  table (`City_RadiusOverrideMI`). The prompt says so too.
- **The table** is `lib/geo/travelify-geo.csv`, the Travelify geo export
  verbatim, compiled to `lib/geo/travelify-geo.json` by
  `node scripts/build-geo-table.js`. To refresh it, export again from
  Travelify, drop the CSV over the old one, run the script and commit both.
- **Misses are logged**, one line per link: `[geo] loc="..." miss`. Read them
  in the Vercel logs to see which destinations visitors ask for that the table
  does not know yet, and add them at source.
- **Links for unknown places are left exactly as the model built them**, as
  are Flights links (no place, only airports) and any match whose centre is
  nowhere near the model's own coordinates (Paris, Texas is not Paris).
- **Off switch:** `LUNA_GEO_REWRITE=0`. Nothing else about a reply changes.

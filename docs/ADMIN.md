# The admin area

`/admin/` is a signed-in page with two jobs: recording shared expenses, and
writing blog posts. The whole site runs on Azure Static Web Apps at
**yaolinge.com** - GitHub Pages is not used - and the data lives in Azure Table
Storage.

```
browser -> Static Web Apps (static files + sign-in)
              |
              +-- /api/*  Azure Functions (api/)
                            |
                            +-- Azure Table Storage: expenses, posts
```

Nobody has a password. Static Web Apps handles the sign-in with GitHub, and
tells the API who you are; the API decides what that person may do.

## Roles

| Role    | Can do                                          | Who      |
|---------|-------------------------------------------------|----------|
| `money` | Read and write the expense ledger               | both     |
| `owner` | The above, plus writing posts and importing data | Yao only |

Roles are granted one person at a time from the Azure portal, so there is no
list of allowed users in the code.

## First-time setup

You need the Azure CLI (`az login`) and about ten minutes.

### 1. Storage

```bash
az group create --name money --location norwayeast

az storage account create \
  --name yaolingemoney --resource-group money \
  --location norwayeast --sku Standard_LRS --kind StorageV2

az storage account show-connection-string \
  --name yaolingemoney --resource-group money --query connectionString -o tsv
```

Keep that connection string; it is the only secret in the system.

### 2. The site

Create the Static Web App and point it at this repo. The GitHub Action in
`.github/workflows/azure-static-web-apps.yml` does the deploying, so all Azure
needs is to hand you a deployment token.

```bash
az staticwebapp create \
  --name yaolinge --resource-group money \
  --location westeurope --sku Standard

az staticwebapp secrets set \
  --name yaolinge --resource-group money \
  --setting-names STORAGE_CONNECTION_STRING="<the string from step 1>"

az staticwebapp secrets list --name yaolinge --query "properties.apiKey" -o tsv
```

Put that last value in the repository as the `AZURE_STATIC_WEB_APPS_API_TOKEN`
secret (Settings, Secrets and variables, Actions), then push. The Standard
plan is what allows custom roles; the Free plan does not.

### 3. yaolinge.com

The site is served from `yaolinge.com`, not GitHub Pages. Two names to set up:
`www.yaolinge.com` is a plain subdomain and easy; the apex `yaolinge.com`
cannot be a CNAME, because DNS does not allow one at the root of a zone.

First find the name Azure gave the app - everything below points at it:

```bash
az staticwebapp show --name yaolinge --resource-group money \
  --query defaultHostname -o tsv
# something like calm-sand-0a1b2c3d4.6.azurestaticapps.net
```

**www.yaolinge.com** - validated by the CNAME itself:

```bash
az staticwebapp hostname set --name yaolinge --resource-group money \
  --hostname www.yaolinge.com
```

At your registrar: a `CNAME` record, host `www`, value the default hostname
above (no `https://`).

**yaolinge.com** - validated by a TXT record, then pointed with ALIAS:

```bash
az staticwebapp hostname set --name yaolinge --resource-group money \
  --hostname yaolinge.com --validation-method dns-txt-token

az staticwebapp hostname show --name yaolinge --resource-group money \
  --hostname yaolinge.com --query validationToken -o tsv
```

At your registrar, two records on the root:

| Type | Host | Value |
|------|------|-------|
| `TXT` | `@` | the validation token printed above |
| `ALIAS` (or `ANAME`, or CNAME flattening) | `@` | the default hostname, no `https://` |

If your registrar has none of ALIAS, ANAME or CNAME flattening, you have two
fallbacks. Either forward the apex to `www` at the registrar, or use an `A`
record pointing at the app's `stableInboundIP` (portal, Overview, JSON View).
The `A` record works, but it pins the site to one region and gives up the
global distribution, so prefer ALIAS where you can get it.

Apex DNS changes can take up to 72 hours to propagate. Certificates are issued
and renewed by Azure automatically once validation passes. Until DNS moves, the
site is live on the `*.azurestaticapps.net` name.

### 4. Turn GitHub Pages off

Nothing here depends on Pages any more, and leaving it on means the same
content is served from two places.

Repository **Settings**, **Pages**, set the source to **None**. There is no
`CNAME` file in the repo and there should not be one - that file is a Pages
mechanism and Azure ignores it.

Two consequences worth knowing:

* Links to `yaolinge.github.io` will stop working rather than redirecting.
  If you would rather keep them alive for a while, leave Pages on with a branch
  that contains only a redirect stub, and turn it off later.
* The repository is still *named* `yaolinge.github.io`. That is only a name now;
  rename it if you like, and update the clone path in the money repo's README if
  you do.

### 5. Give yourself the owner role

Azure portal, your Static Web App, **Role management**, **Invite**:

* Authentication provider: GitHub
* Username: your GitHub username
* Roles: `owner,money`

Open the invite link while signed in as that user. Then `/admin/` works.

### 6. Invite your girlfriend

Same screen, her GitHub username, role `money` only. She gets the money page
and nothing else - no blog, no import, no delete of posts. Send her the invite
link; it is single use and expires.

If she would rather not make a GitHub account, add another provider to the
Static Web App and invite her through that instead; the API does not care which
provider a person used.

## Moving the existing data in

Both scripts are safe to re-run: they skip what is already there.

```bash
export STORAGE_CONNECTION_STRING="<the string from step 1>"

# the 37 posts that are static files today
node scripts/import-posts.mjs --dry-run
node scripts/import-posts.mjs

# the rows from the money repo
node scripts/import-expenses.mjs ~/money/yao.csv:y ~/money/vollum.csv:v --dry-run
node scripts/import-expenses.mjs ~/money/yao.csv:y ~/money/vollum.csv:v
```

Imported posts keep `legacyPath`, so `posts.html` keeps linking to the original
`blogs/*.html` file and no URL that exists today changes. Editing one in the
admin replaces its body with what you write in Markdown.

The expense import **drops rows the CSVs contain twice**, which in the files as
they stand is one row - "felleskostnader july", 2358.00 kr, in `yao.csv` twice.
That moves the balance by that amount. Pass `--keep-duplicates` to import
verbatim and decide in the admin instead. The script says which rows it dropped.

## Keeping run.py working

The money repo's `run.py` reads two CSVs. Write fresh ones from the database:

```bash
STORAGE_CONNECTION_STRING="..." node scripts/export-csv.mjs ~/money
cd ~/money && python3 run.py
```

The export is byte-compatible with the old files, and both implementations of
the settlement rule are tested against the same numbers, so the two never
disagree.

## Running it locally

```bash
npx azurite --silent --location .azurite &     # the storage emulator
node scripts/dev-server.mjs --as owner         # or --as money, --as anonymous
```

`http://127.0.0.1:4280/admin/`. There is no sign-in locally, so the dev server
fakes the header Azure would send and applies the same route rules from
`staticwebapp.config.json`.

## Tests

```bash
cd api && npm test
```

91 tests. The storage and API tests run against Azurite, which speaks the real
Azure Tables protocol, so the storage layer is genuinely exercised rather than
mocked. They start and stop it themselves.

## What is where

```
staticwebapp.config.json  routes, roles, and which paths need which role
api/src/lib/money.js      amounts, dates, and the settlement rule
api/src/lib/markdown.js   Markdown -> HTML, done once when a post is saved
api/src/lib/tables.js     Table Storage: the only place data lives
api/src/lib/handlers.js   the API, as plain functions
api/src/index.js          the Azure Functions bindings (an adapter, nothing more)
admin/                    the admin page
post.html, posts.html     the public blog, reading from the API
scripts/                  import, export, and the local dev server
```

## Cost

Static Web Apps Standard is about $9/month. Table Storage for a few thousand
rows is pennies. If the Standard plan is not worth it, the Free plan works for
everything except custom roles - you would then have to check identities in the
API rather than by role.

## If something breaks

* **`/admin/` bounces to a login loop** - the account you signed in with has no
  role. Check Role management.
* **The admin loads but the money panel is empty** - the API cannot reach
  storage. Check `STORAGE_CONNECTION_STRING` in the Static Web App's
  configuration, then the Function logs in the portal.
* **A post shows as "not found"** - it is still a draft. Drafts are only
  readable by `owner`.
* **The balance disagrees with `run.py`** - re-export the CSVs; the report reads
  files, not the database.

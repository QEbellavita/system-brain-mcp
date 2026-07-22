<p align="center">
  <img src="./assets/header.svg" alt="system-brain-mcp — where code deploys, what's fabricated, whether the loop closes" width="100%">
</p>

<p align="center"><a href="https://github.com/QEbellavita/system-brain-mcp/actions/workflows/test.yml"><img src="https://github.com/QEbellavita/system-brain-mcp/actions/workflows/test.yml/badge.svg" alt="tests"></a></p>

Your agent just deployed to the wrong place. Again.

Eleven read-only MCP tools that let a coding agent ask honest questions about the system
it's working in — where this code actually deploys, what in it is fake, what's still open,
whether the learning loop is closing, and what the evidence says to work on next.

```
brain_where_deploys  src/api/routes/health.ts

  canonical :  railway / api-service / main / autoDeploy=true
  detected  :  railway.json, vercel.json, .github/workflows/deploy.yml
  agreement :  confirmed-with-strays        confidence: medium
  strays    :  [ 'vercel' ]
  guidance  :  Canonical target is railway, but config for vercel is also present.
               A leftover project on another platform is the usual cause of
               "production keeps reverting" — confirm it is disconnected, or
               delete the stray config.
```

That cross-check is the point. Not "read the config file" — an agent can already do that.
Rather: **does your declared deploy target agree with what's actually in the repo, and how
much should you trust the answer?**

## Start here

```bash
npx -y -p system-brain-mcp system-brain-init ~/code   # scan your repos, draft a manifest
```

Or from source:

```bash
git clone https://github.com/QEbellavita/system-brain-mcp
cd system-brain-mcp && npm install
node bin/init.js ~/code            # same init, from the checkout
```

`init` walks your directories, finds git repos, reads their platform config files, and asks
the platform CLIs what they're linked to. It writes a draft manifest with everything it
could work out, and flags everything it couldn't:

```json
{
  "match": ["/Users/you/code/dashboard/**"],
  "platform": "railway",
  "service": null,
  "_detected": ["railway.json", "vercel.json"],
  "_uncertain": [
    "multiple platform configs found (railway.json, vercel.json) — pick the canonical one",
    "service name unknown — fill in the name your platform shows"
  ]
}
```

Fill in the nulls, delete the `_` keys, and the manifest is yours. It never guesses
silently — if it isn't sure, it says so in `_uncertain`.

Then point your MCP client at it:

```json
{
  "mcpServers": {
    "system-brain": {
      "command": "npx",
      "args": ["-y", "system-brain-mcp"],
      "env": {
        "SYSTEM_BRAIN_DEPLOY_MANIFEST": "/Users/you/.config/system-brain/deploy-targets.json",
        "SYSTEM_BRAIN_FABRICATION_DIRS": "/Users/you/code/app/src:/Users/you/code/app/lib"
      }
    }
  }
}
```

(From a source checkout, use `"command": "node", "args": ["/absolute/path/to/system-brain-mcp/server.js"]` instead.)

## Tools

| Tool | Answers |
|---|---|
| `brain_where_deploys` | Where does this file's code actually go, and does the repo agree? |
| `brain_fabrication_audit` | Which "implemented" functions return `Math.random()` dressed as a real value? |
| `brain_backlog` | What's open across GitHub PRs/issues and local git branches? |
| `brain_db_schema` | What tables exist, what columns, how many rows? |
| `brain_analytics` | Is the prediction→outcome loop closing, or is it starved? |
| `brain_ml_models` | What model artifacts exist on disk? |
| `brain_architecture` | Index and read the docs that describe this system |
| `brain_lenses` | Mental models for framing a decision |
| `brain_roadmap` | Which plan/roadmap notes still have open `- [ ]` items? |
| `brain_recommend` | Ranked next steps, each citing the tool and number it came from |
| `brain_reframe` | One recommendation, pushed through a reasoning lens with an adversarial gate |

Everything is **read-only**. Nothing writes to your database, repos, or deploy targets.

## On `brain_recommend`

A deterministic rule table over the brain's own evidence — **not a model**. Each rule fires
only when its source reports `complete` health, so a failed GitHub call or an unreadable
database produces *fewer* recommendations, never invented ones. If nothing fires, you get
an empty list and `"No actionable signals from current data."` — which is an answer, not a
failure.

The output ends with a `reasoning` contract: static, server-authored instructions the
calling model is expected to execute — rank the candidates against live session context,
Goodhart-check any metric-driven ones, and state what would change its mind. The server
surfaces candidates; the judgment stays with the model, where the live context is.

`brain_reframe` then takes one candidate (looked up server-side by key — priority and
evidence can't be spoofed by the caller) and frames it through the best-scoring reasoning
lens. This build ships no knowledge base, so reframe's evidence health always gates to
non-complete — which deliberately trips the adversarial review (red-team, steel-man,
pre-mortem) rather than letting absent evidence read as support.

## Configuration

Every knob is an environment variable, and nothing has a default that assumes your layout:

| Variable | |
|---|---|
| `SYSTEM_BRAIN_DEPLOY_MANIFEST` | Path to the manifest `init` wrote |
| `SYSTEM_BRAIN_FABRICATION_DIRS` | Colon-separated dirs to scan for fabricated values |
| `SYSTEM_BRAIN_DB` | SQLite path for `db_schema` / `analytics` |
| `SYSTEM_BRAIN_MODELS_DIRS` | Colon-separated dirs holding model artifacts |
| `SYSTEM_BRAIN_ARCH_DOCS` | Colon-separated markdown files describing your system |
| `SYSTEM_BRAIN_OBSIDIAN_VAULTS` | `{"Name":"/path"}` — optional, for `backlog --includeVault` and `roadmap` |

Two JSON files under `config/` shape the rest. Copy the `.default.json` and edit:

- **`taxonomy.json`** — your systems, phases, work types and risk tags. The MCP input
  schemas are built from this at load, so the tool contract describes *your* system. The
  shipped default is generic (`api`, `frontend`, `data`, `jobs`, `infra`, `auth`, `docs`).
- **`analytics.json`** — your outcome-ledger table and its label column, your prediction
  tables, and the thresholds for calling a feedback loop starved.

If you have no ML loop, leave the analytics tables empty. `brain_analytics` reports "not
configured" rather than inventing a number.

## On `brain_analytics`

It answers one question: **of the predictions that entered the outcome ledger, how many
ever got a real label?**

Two design notes worth knowing, both learned the hard way:

- Raw prediction logs are reported as *activity*, never as the coverage denominator.
  Folding them in manufactures a false 0% and a phantom famine alarm — a few hundred seed
  rows will drown a handful of genuine labeled outcomes and make a healthy loop look dead.
- Below `ledgerMinForFamine` rows the ratio is noise, so a low value reports as "warming
  up" rather than an alarm. A two-row dev database is not evidence of a broken pipeline.

## On `brain_fabrication_audit`

It matches two tight patterns — a `Math.random()` feeding something named `confidence`,
`accuracy`, `score` or `decision`, and a bare `return Math.random() < x` decision.

A naive `Math.random()` grep over a real codebase returns thousands of hits: jitter, IDs,
test fixtures. These two catch the actual tell — a random number standing in for a value
that reads as computed.

**It is a signal, not proof.** Read the surrounding function before calling anything fake.

## Tests

```bash
npm test
```

72 tests, no network and no database required. The service takes injected `fs` and `exec`
implementations, so SQLite behaviour is driven through a faked `sqlite3` CLI and filesystem
cases run in temp dirs.

## Licence

MIT — see [LICENSE](LICENSE).

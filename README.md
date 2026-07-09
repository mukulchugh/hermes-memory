# hermes-memory

A [Hermes Agent](https://github.com/NousResearch/hermes) **dashboard plugin** that visualizes the self-hosted [Honcho](https://github.com/plastic-labs/honcho) theory-of-mind memory — live, inside the dashboard, behind its existing auth.

Adds a **Memory** tab with five surfaces, all driven dynamically from the Honcho API (no hardcoded peers, levels, or workspace — it renders whatever your memory contains, at any volume):

- **Memory Pipeline** — what the deriver is doing: messages → reconciler/embeddings → representation queue → documents → dreams, with the live work-queue depth (`queue/status`).
- **Theory-of-Mind Graph** — peers as nodes, `observer → observed` edges weighted by fact count. Drag nodes, click a node to filter its facts, click an edge to open that collection.
- **Fact Explorer** — every derived conclusion, filterable by peer and level (explicit / deductive / inductive / …), with search.
- **Ask the Memory** — dialectic Q&A: ask one peer what it knows (optionally about another peer).
- **Dreams** — collection consolidation overview + a "schedule dream" button.

## How it works

`dashboard/plugin_api.py` is a read-only FastAPI router mounted at `/api/plugins/hermes-memory/`. It proxies the Honcho REST API (`/v3/workspaces/<ws>/…`) server-side, so Honcho stays on localhost and the browser only talks to the dashboard (behind its session auth). It pages through `conclusions/list` and aggregates in Python, so peers/levels/edges are discovered at runtime and it scales to any memory size (45s cache).

The UI (`dashboard/dist/index.js`) is a dependency-free IIFE using the dashboard's Plugin SDK (`window.__HERMES_PLUGIN_SDK__`) — React and UI primitives are provided by the host, never bundled. All colors reference the dashboard's `--color-*` theme tokens, so it reskins with the active theme.

Only two endpoints ever write, and both are explicitly user-triggered: the dialectic **chat** and **schedule dream**.

## Install

Dashboard plugins are installed by directory. Clone into your Hermes plugins dir and enable:

```bash
git clone https://github.com/mukulchugh/hermes-memory.git ~/.hermes/plugins/hermes-memory
# add "hermes-memory" to plugins.enabled in ~/.hermes/config.yaml, then:
curl http://127.0.0.1:9119/api/dashboard/plugins/rescan   # reload the UI tab
# restart the dashboard once so the backend routes mount:
#   systemctl --user restart hermes-dashboard   (or: hermes dashboard --stop && hermes dashboard)
```

Pull improvements later with `git -C ~/.hermes/plugins/hermes-memory pull` (UI: rescan; backend changes: restart).

## Config

| Env var | Default | Meaning |
|---|---|---|
| `HONCHO_BASE_URL` | `http://127.0.0.1:8000` | Honcho API base |
| `HONCHO_WORKSPACE` | `hermes` | Default workspace (overridable per request via `?ws=`) |

## License

MIT

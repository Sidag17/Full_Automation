# MERN Handoff Package

Portable context package for your **Node.js / Express / MongoDB / React** automation project.

This folder was generated from the Python flash/VCOM automation repo. It does **not** run Python. Copy it into your Node.js workspace so Cursor (and developers) have full settings, API contracts, and hardware behavior rules.

## What is inside

| Path | Purpose |
|------|---------|
| `HANDOFF.md` | One-page contract for the Node workspace |
| `REFERENCE_SOURCES.md` | Which Python files to read for behavior parity |
| `.cursor/rules/hardware-automation.mdc` | Cursor rule (auto-loaded context) |
| `docs/` | Backend design, settings, boards, tasks, CSV/status |
| `config/` | JSON defaults, board seed, Commander templates, `.env` example |
| `package-hints/` | Suggested npm dependencies |

## How to copy into your Node.js project

1. Copy the entire `mern-handoff/` folder into the **root** of your Node/MERN repo.
2. Merge Cursor rules:
   - Ensure `mern-handoff/.cursor/rules/hardware-automation.mdc` is available as `.cursor/rules/hardware-automation.mdc` in the Node repo root  
     (either move/copy the rule file, or keep `mern-handoff/` and point agents at it).
3. Use `mern-handoff/config/*.json` and `env.example` when seeding Mongo settings and local env.
4. Do **not** modify the Python automation repo from the Node workspace.

### Recommended copy layout in Node repo

```
your-mern-repo/
  .cursor/rules/hardware-automation.mdc   ← from mern-handoff/.cursor/rules/
  mern-handoff/                           ← entire folder (docs + config)
  backend/
  frontend/
```

## First Agent prompt (paste in Node workspace)

```
Implement the local Windows MERN hardware automation platform using the handoff package in mern-handoff/.

Locked decisions:
- Node.js + Express only (no Python runtime/worker)
- Browser never accesses files, J-Link, or COM ports — Node worker owns those
- Build is a pluggable command adapter
- Sequential operations per board (never flash two boards in parallel in v1)
- Open VCOM before reset so boot logs are not missed
- VCOM over IP uses TCP port 4901; strip empty --ip/--serialno/--device from Commander argv

Read and follow:
- mern-handoff/HANDOFF.md
- mern-handoff/docs/backend-design.md
- mern-handoff/docs/node-settings-and-config.md
- mern-handoff/docs/workflow-tasks.md
- mern-handoff/config/system-settings.defaults.json
- mern-handoff/config/boards.seed.json

Seed settings and boards from the config JSON files. Implement API endpoints as specified in backend-design.md.
```

## Source Python repo (read-only reference)

`c:\Work\Personal Project\ml_example_application_test_automation`

# Handoff Contract — Local MERN Automation Platform

## Product goal

Local Windows web automation platform (MongoDB + Express + React + Node.js) that can:

1. Download / validate / extract Gecko SDK + AIML + WiseConnect extension ZIPs
2. Prepare SDK (`extension/` folder with AIML and WiseConnect)
3. Validate app × board × toolchain combinations
4. Build binaries (pluggable adapter) **or** import / discover prebuilt `.s37` files
5. Flash boards via Simplicity Commander (`--ip` and/or `--serialno`)
6. Reset boards
7. Capture VCOM logs (local COM or TCP `ip:4901`)
8. Store statuses and generate CSV reports

Workflows are **non-linear**: steps are independent tasks with soft artifact dependencies (not a forced pipeline).

## Locked decisions

| Decision | Value |
|----------|-------|
| Runtime | **Node.js + Express only** — do not call or embed Python |
| Hardware I/O | Local Node worker (`child_process.spawn`, `serialport`, TCP sockets, filesystem) |
| Browser | HTTP/JSON to Express only — no direct file, J-Link, or COM access |
| Build | Pluggable command-adapter (SLC/make templates configurable later) |
| Board concurrency (v1) | One board at a time for probe/flash/reset/capture; binaries on a board run sequentially |
| Fail policy (default) | Continue siblings on failure (same as Python automation) |

## Hard constraints (from Python behavior)

1. Prefer **open VCOM before reset** so boot messages are not missed.
2. IP-connected kits often have **no COM port**; default VCOM path is **TCP port 4901**.
3. Commander argv templates use placeholders: `{commander}`, `{binary}`, `{ip}`, `{serialno}`, `{chip_type}`.
4. **Strip** empty `--ip` / `--serialno` / `--device` flag pairs after substitution.
5. Flash retries: **3** (configurable). Flash timeout: **120** seconds (configurable).
6. Status vocabulary:
   - Flash: `PASS` | `FAIL`
   - Reset: `PASS` | `FAIL` | `NOT_RUN`
   - Log capture: `PASS` | `FAIL` | `VCOM_ERROR` | `NOT_RUN`

## Where to look in this package

| Need | File |
|------|------|
| Copy / Agent prompt | [README.md](README.md) |
| API endpoints + run examples | [docs/backend-design.md](docs/backend-design.md) |
| Settings, env, workspace paths | [docs/node-settings-and-config.md](docs/node-settings-and-config.md) |
| Board fields + connection rules | [docs/board-schema.md](docs/board-schema.md) |
| Task catalog | [docs/workflow-tasks.md](docs/workflow-tasks.md) |
| CSV columns / statuses | [docs/status-and-csv.md](docs/status-and-csv.md) |
| npm packages | [package-hints/backend-dependencies.md](package-hints/backend-dependencies.md) |
| Defaults JSON | [config/system-settings.defaults.json](config/system-settings.defaults.json) |
| Board seed | [config/boards.seed.json](config/boards.seed.json) |
| Commander templates | [config/commander-templates.json](config/commander-templates.json) |
| Env template | [config/env.example](config/env.example) |
| Python parity map | [REFERENCE_SOURCES.md](REFERENCE_SOURCES.md) |

## Python reference root (read-only)

```
c:\Work\Personal Project\ml_example_application_test_automation
```

Do not modify that repo when implementing the Node project. Use it only to read behavior for parity.

# Board schema

## Fields

| Field | Type | Purpose |
|-------|------|---------|
| `name` | string | Lowercase board id, e.g. `brd2705a` |
| `ip` | string | Adapter/debugger IP for Commander `--ip` and VCOM TCP |
| `serialno` | string | USB/J-Link serial for Commander `--serialno` |
| `chipType` | string | Optional `--device` value |
| `vcomPort` | string | Optional local `COMx` |
| `vcomMode` | string | Optional override of global `vcom.mode` (`auto`/`ip`/`com`) |
| `baudRate` | number | Serial baud (default `115200`) |
| `enabled` | boolean | Include in selection / discovery matching |

Seed data: [../config/boards.seed.json](../config/boards.seed.json) (exported from Python `config.yaml`).

## Connection rules

- For **probe / flash / reset**: at least one of `ip` or `serialno` must be non-empty.
- Commander templates should include the flags you need; empty values are stripped.
- For **VCOM**:
  - `mode=ip` → require `ip`, connect `tcp://ip:tcpPort` (port default 4901)
  - `mode=com` → require `vcomPort` and that COM must exist on the PC
  - `mode=auto` → use COM if present, else fall back to IP TCP

## Discovery mapping

Application / path tokens use regex (case-insensitive):

```
brd[0-9]+[a-z]+
```

Examples:

- Folder `aiml_soc_model_profiler_siwg917_brd4342a` → board `brd4342a`
- Path `.../brd2705a/gcc/aiml_soc_.../app.s37` → prefer path segment `brd2705a`

Board names in DB should match these tokens (lowercase).

## Adding a board (Node)

`POST /api/boards` with the fields above. No code change required — same model as Python config-driven boards.

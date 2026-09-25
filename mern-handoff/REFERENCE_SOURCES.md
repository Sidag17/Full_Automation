# Python reference sources (behavior parity)

Use these files as a **read-only specification** when porting hardware logic to Node.js. Do not execute or modify them from the Node project.

**Python repo root:**  
`c:\Work\Personal Project\ml_example_application_test_automation`

| Node concern | Python file(s) | What to port |
|--------------|----------------|--------------|
| System + board defaults | `config.yaml` | Commander path, templates, VCOM, toolchains, board inventory |
| Probe / flash / reset | `flash_manager.py` | `subprocess` → `child_process.spawn`; retry loop; timeout; `CommandResult` |
| Command formatting | `utils.py` → `format_command` | Placeholder fill; drop empty `--ip` / `--serialno` / `--device` pairs |
| Board registry | `board_manager.py` | Board fields: name, ip, chip_type, vcom_port, serialno, baud, enabled |
| VCOM open + capture | `vcom_logger.py` | mode `auto`/`ip`/`com`; COM via serialport; IP via TCP 4901; open-before-reset |
| List COM ports | `vcom_logger.py` → `list_com_ports` | Enumerate local serial ports for `/api/system/com-ports` |
| Discover `.s37` | `discovery.py` | Recurse root; toolchain folder names; extract `brd####x` |
| Board name from path | `utils.py` → `extract_board_name`, `extract_board_from_path`, `detect_toolchain` | Regex `(brd[0-9]+[a-z]+)` |
| Orchestration order | `main.py` | Group by board; sequential boards; flash → open VCOM → reset → capture → CSV |
| CSV report | `report_manager.py` | Columns and append-only rows |
| High-level docs | `README.md` | Operator-facing flow and status meanings |

## Behavior checklist for Node worker

- [ ] Validate Commander executable exists before flash jobs
- [ ] Probe adapter (IP and/or serialno)
- [ ] Flash with up to 3 retries
- [ ] On flash FAIL: reset/capture = `NOT_RUN`
- [ ] Open VCOM session before reset
- [ ] On VCOM unavailable: still attempt reset; capture = `VCOM_ERROR`
- [ ] Write log under `logs/<board>/<toolchain>/<application>.log` (or run-scoped equivalent)
- [ ] Append CSV row after each binary / task unit
- [ ] Never flash two different boards in parallel (v1)

## Out of scope in Python (new in Node)

These do **not** exist in the Python project — design them fresh using `docs/workflow-tasks.md`:

- Download SDK / extension ZIPs
- Extract packages
- Prepare `sdkRoot/extension/`
- Build binaries
- Compatibility matrix validation
- HTTP API / Mongo / React UI

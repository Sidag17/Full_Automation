# Status vocabulary and CSV report

## Status values (preserve from Python)

| Area | Allowed values |
|------|----------------|
| Flash | `PASS`, `FAIL` |
| Reset | `PASS`, `FAIL`, `NOT_RUN` |
| Log capture | `PASS`, `FAIL`, `VCOM_ERROR`, `NOT_RUN` |
| Build (new) | `PASS`, `FAIL`, `NOT_RUN`, `SKIPPED` |
| Package / prepare (new) | `PASS`, `FAIL`, `NOT_RUN` |

## Behavioral rules

1. Flash failure → reset and capture = `NOT_RUN` for that binary unit.
2. VCOM cannot open → capture = `VCOM_ERROR`; still attempt reset if reset was requested.
3. Capture-only / reset-only runs do not require a prior flash in the same run.
4. Default run policy: continue other tasks after a failure (do not fail-fast unless configured).

## CSV columns (hardware parity)

Match current Python `report_manager.py`:

```
DateTime, Board, Board_IP, Toolchain, Application, Binary_Name,
Flash_Status, Reset_Status, Log_Capture_Status, Log_File, Execution_Time
```

### Extended columns (recommended for full MERN runs)

Add when SDK/build steps exist:

```
Run_Id, Task_Id, Board_Serial, Build_Status, Package_Status,
Sdk_Workspace, Source (build|import|discover)
```

## Log file layout

Python-compatible pattern:

```
logs/<board>/<toolchain>/<application>.log
```

Run-scoped alternative (also acceptable):

```
logs/<runId>/<board>/<toolchain>/<application>.log
```

Store the absolute or workspace-relative path in `Log_File` / task outputs.

## Report API

- `GET /api/runs/:id/report` — generate or download CSV for the run
- Persist a `reports` document with path + timestamp

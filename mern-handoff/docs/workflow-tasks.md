# Independent workflow tasks

Each task is a backend unit of work with inputs, outputs, soft dependencies (artifacts), retry budget, and resource locks.

Orchestrator rule: check **artifact availability**, not “previous step must have executed in this run.”

## Task catalog

| Task type | Inputs | Outputs | Soft dependency | Retry | Resource lock |
|-----------|--------|---------|-----------------|-------|---------------|
| `VALIDATE_URLS` | package URLs | validation result | none | 1 | none |
| `DOWNLOAD_PACKAGE` | URL, kind (`gecko`/`aiml`/`wiseconnect`) | zip path, checksum | URLs valid | 2 | network |
| `EXTRACT_GECKO_SDK` | gecko zip | `sdkRoot` path | gecko zip | 1 | disk |
| `EXTRACT_EXTENSION` | ext zip, kind | extracted folder | ext zip | 1 | disk |
| `PREPARE_SDK` | sdkRoot + ext folders **or** existing sdk path | `sdkRoot/extension/...` | extracts **or** user SDK | 1 | sdkPath |
| `VALIDATE_COMBINATIONS` | apps × boards × toolchains | allowed matrix + skips | prepared SDK and/or rules | 0 | none |
| `BUILD_APP` | sdkRoot, app, board, toolchain | binary artifact (`.s37`) | prepared SDK | 1 | toolchain/CPU |
| `IMPORT_PREBUILT` | local path / metadata | binary artifact | none | 0 | disk |
| `DISCOVER_BINARIES` | root folder | binary list + board/toolchain/app | none | 0 | disk |
| `PROBE_BOARD` | boardId | connection status | none | 1 | board |
| `FLASH_BOARD` | boardId, binaryId | flash status | compatible binary (any source) | 3 | board |
| `RESET_BOARD` | boardId | reset status | none | 1 | board |
| `CAPTURE_VCOM` | boardId, duration, context | log path + status | reachable VCOM only | 1 | board+vcom |
| `GENERATE_REPORT` | runId | CSV path | task results exist | 1 | none |

## Artifact examples

| Artifact | May come from |
|----------|----------------|
| Prepared SDK | Current `PREPARE_SDK` **or** `POST /api/sdk/import-existing` |
| Binary `.s37` | `BUILD_APP`, `IMPORT_PREBUILT`, `DISCOVER_BINARIES`, or prior run |
| Board connection | Live probe; not required for capture if firmware already present |

## Non-linear workflow examples

| Intent | Typical tasks |
|--------|----------------|
| Download → Prepare → Build → Flash → Reset → Capture | All package + build + hardware tasks |
| Prepare → Build only | `PREPARE_SDK`, `VALIDATE_COMBINATIONS`, `BUILD_APP` |
| Build → Flash | `BUILD_APP`, `FLASH_BOARD` |
| Import → Flash → Reset → Capture | `IMPORT_PREBUILT`, `FLASH_BOARD`, `RESET_BOARD`, `CAPTURE_VCOM` |
| Flash only | `FLASH_BOARD` |
| Reset only | `RESET_BOARD` |
| Capture only | `CAPTURE_VCOM` |
| Retry failed | Requeue selected `FAILED` tasks only |

## Hardware combo (Python parity)

For flash-reset-capture on one binary:

1. `PROBE_BOARD` (optional but recommended)
2. `FLASH_BOARD`
3. Open VCOM
4. `RESET_BOARD`
5. `CAPTURE_VCOM`
6. Append CSV / `GENERATE_REPORT`

Open VCOM **before** reset.

## Concurrency

- Global mutex per `boardId` for `PROBE_BOARD`, `FLASH_BOARD`, `RESET_BOARD`, `CAPTURE_VCOM`.
- v1 scheduler: process boards sequentially (never two boards flashing at once).

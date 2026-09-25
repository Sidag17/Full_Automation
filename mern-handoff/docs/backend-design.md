# Backend design — Express API and orchestration

Base prefix: `/api`. All operations are local. Browser never opens files, J-Link, or COM ports.

## Architecture

```
React UI  --HTTP/JSON-->  Express API  -->  MongoDB
                              |
                              v
                      Workflow Orchestrator
                              |
                              v
                         Task Queue (in-process)
                              |
                              v
                      Local Node Worker
                         |    |    |
                      Disk  Commander  VCOM (COM or TCP 4901)
```

## Mongo collections

- `settings` — singleton system config
- `boards` — hardware inventory
- `packages` — downloaded ZIP metadata
- `sdkWorkspaces` — prepared SDK roots + extension status
- `binaries` — artifact registry (`source`: `build` | `import` | `discover`)
- `compatibilityRules` — allow/deny matrix
- `runs` — workflow instance
- `tasks` — independent units (`type`, `status`, `inputs`, `outputs`, `error`, `attempts`, `resourceKey`)
- `reports` — CSV path + column snapshot

## Endpoints

### Health and system

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | API + Mongo + commander path exists |
| `GET` | `/api/system/settings` | Commander, VCOM defaults, paths, toolchains |
| `PUT` | `/api/system/settings` | Update settings |
| `GET` | `/api/system/com-ports` | List local COM ports |
| `POST` | `/api/system/probe-commander` | Verify Commander executable |

### Boards

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/boards` | List boards |
| `POST` | `/api/boards` | Create board |
| `GET` | `/api/boards/:id` | Get one |
| `PUT` | `/api/boards/:id` | Update |
| `DELETE` | `/api/boards/:id` | Delete |
| `POST` | `/api/boards/:id/probe` | Run `PROBE_BOARD` immediately |
| `POST` | `/api/boards/detect` | Suggest boards from `.s37` paths |

### Packages / SDK

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/sdk/validate` | Validate `build` + Artifactory URL (gecko zip reachable) |
| `POST` | `/api/sdk/prepare` | Download gecko + extensions, extract to `C:\{build}\gecko-sdk` |
| `GET` | `/api/sdk/prepare` | List recent SDK prepare runs |
| `GET` | `/api/sdk/prepare/:id` | Prepare run status |
| `POST` | `/api/sdk/prepare/:id/cancel` | Soft-cancel prepare run |
| `POST` | `/api/packages/validate` | Validate download URLs (legacy name) |
| `POST` | `/api/packages/download` | Download packages |
| `GET` | `/api/packages` | List downloaded packages |
| `GET` | `/api/sdk` | List prepared SDK workspaces |
| `GET` | `/api/sdk/:id` | SDK detail |
| `POST` | `/api/sdk/import-existing` | Register an existing local SDK directory |

#### `POST /api/sdk/prepare` body

```json
{
  "build": "990",
  "artifactoryUrl": "https://artifactory.silabs.net/ui/native/gsdk-generic-development/sisdk-2026.12/990/",
  "extensions": ["aiml-extension", "wiseconnect"],
  "force": false,
  "downloadConcurrency": 4
}
```

- `build` (required) — folder name only; becomes `C:\990\gecko-sdk` (not parsed from URL).
- `artifactoryUrl` (required) — validated up front; invalid/unreachable gecko zip → **400** with a clear error.
- `extensions` (optional) — overrides `settings.sdkPrepare.defaultExtensions` (no code change for new names).
- `force` — re-download even if SDK already present.
- `downloadConcurrency` (optional, default 4) — max parallel ZIP downloads (gecko + extensions). Extraction remains sequential.

Auth via env: `ARTIFACTORY_TOKEN` or `ARTIFACTORY_USER` + `ARTIFACTORY_PASSWORD`.

### Builds (SLC + CMake)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/builds` | Enqueue build run (async 202) |
| `GET` | `/api/builds` | List recent build runs |
| `GET` | `/api/builds/:id` | Build status + per-unit results |
| `POST` | `/api/builds/:id/cancel` | Cancel; kills in-flight generate/build |
| `GET` | `/api/builds/:id/report` | Download build CSV |

Jobs form (different apps can use different toolchain sets; units run in parallel up to `concurrency`):

```json
{
  "jobs": [
    {
      "build": "990",
      "board": "brd4343a",
      "projects": ["aiml_soc_profiler_firmware_siwg917"],
      "toolchains": ["gcc", "llvm", "gcc_lto", "llvm_lto"]
    },
    {
      "build": "990",
      "board": "brd4343a",
      "projects": ["aiml_soc_blink_siwg917", "aiml_soc_magic_wand_siwg917"],
      "toolchains": ["gcc", "llvm"]
    }
  ],
  "concurrency": 2
}
```

Flat form:

```json
{
  "build": "3075",
  "board": "brd4187c",
  "projects": ["aiml_soc_blink_efr32"],
  "toolchains": ["gcc_lto", "llvm_lto"]
}
```

Artifacts: `{discovery.defaultRootFolder}/{build}/{board}/{toolchain}/{project}_{board}/`

If `{generateDir}/cmake_{compiler}/build` already has firmware, the unit skips
SLC/CMake and only copies to the artifact folder (`COPIED_EXISTING`). Pass
`"forceRebuild": true` to wipe and rebuild.

### Hardware (standalone)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/hardware/flash` | Flash board↔binary pairs |
| `POST` | `/api/hardware/reset` | Reset selected boards |
| `POST` | `/api/hardware/capture` | Capture VCOM |
| `POST` | `/api/hardware/flash-reset-capture` | Python-parity combo loop |

### Runs / orchestration

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/runs` | Create run from steps + inputs |
| `GET` | `/api/runs` | List runs |
| `GET` | `/api/runs/:id` | Run detail + tasks |
| `GET` | `/api/runs/:id/tasks` | Tasks only |
| `GET` | `/api/runs/:id/tasks/:taskId` | Single task + logs |
| `POST` | `/api/runs/:id/cancel` | Cancel queued/running |
| `POST` | `/api/runs/:id/retry` | Retry failed (`all` or `taskIds`) |
| `GET` | `/api/runs/:id/report` | Download/generate CSV |
| `GET` | `/api/runs/:id/logs` | Aggregated run log |

## Example `POST /api/runs` bodies

### Full pipeline

```json
{
  "steps": ["DOWNLOAD", "PREPARE_SDK", "BUILD", "FLASH", "RESET", "CAPTURE", "REPORT"],
  "packages": {
    "geckoUrl": "https://example/gecko.zip",
    "aimlUrl": "https://example/aiml.zip",
    "wiseConnectUrl": "https://example/wiseconnect.zip"
  },
  "boards": ["brd2705a"],
  "applications": ["aiml_soc_model_profiler_efr32_brd2705a"],
  "toolchains": ["gcc", "llvm_lto"],
  "captureTimeoutSeconds": 30
}
```

### Prebuilt → flash → reset → capture

```json
{
  "steps": ["IMPORT_PREBUILT", "FLASH", "RESET", "CAPTURE", "REPORT"],
  "binaryIds": ["<binaryId>"],
  "boardBinaryMap": { "brd2705a": "<binaryId>" }
}
```

### Capture only

```json
{
  "steps": ["CAPTURE"],
  "boards": ["brd2705a"],
  "captureTimeoutSeconds": 30
}
```

## Workflow → endpoint mapping

| User intent | Primary API |
|-------------|-------------|
| Full pipeline | `POST /api/runs` with full `steps` |
| Prepare → Build only | `steps: [PREPARE_SDK, BUILD]` or separate SDK/build endpoints |
| Build → Flash | `steps: [BUILD, FLASH]` |
| Import prebuilt → Flash → Reset → Capture | `steps: [IMPORT_PREBUILT, FLASH, RESET, CAPTURE]` |
| Flash / Reset / Capture only | `/api/hardware/*` or single-step run |
| Retry failed only | `POST /api/runs/:id/retry` |

## Creating a run (backend flow)

1. Validate payload; expand into a task graph (Cartesian products where needed).
2. Tasks with no unmet artifact deps become `QUEUED`.
3. Worker executes respecting resource locks.
4. On failure → `FAILED`; siblings continue by default.
5. `POST .../retry` requeues failed tasks.
6. Optional `GENERATE_REPORT` writes CSV when the run is terminal.

See also: [workflow-tasks.md](workflow-tasks.md).

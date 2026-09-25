# Node.js settings and configuration

## Environment variables

Copy [../config/env.example](../config/env.example) to the Node backend `.env`.

| Variable | Purpose |
|----------|---------|
| `PORT` | Express listen port (default `5000`) |
| `MONGODB_URI` | Mongo connection string |
| `WORKSPACE_ROOT` | Root for downloads/sdks/binaries/logs/reports |
| `COMMANDER_PATH` | Optional override for Commander executable |
| `CORS_ORIGIN` | Local React origin |
| `LOG_LEVEL` | `info` / `debug` / … |
| `DEFAULT_CAPTURE_TIMEOUT_SECONDS` | Fallback capture duration |
| `FLASH_RETRY_COUNT` | Optional override (prefer Mongo settings) |
| `FLASH_TIMEOUT_SECONDS` | Optional override |

## Mongo `settings` singleton

Seed from [../config/system-settings.defaults.json](../config/system-settings.defaults.json).

### `flashTool`

| Field | Type | Default / meaning |
|-------|------|-------------------|
| `commanderPath` | string | Path to `commander.exe` |
| `timeoutSeconds` | number | `120` |
| `flashRetryCount` | number | `3` |
| `useDeviceArgument` | boolean | If false, force empty `chip_type` so `--device` is stripped |
| `probeCommand` | string[] | Argv template |
| `flashCommand` | string[] | Argv template |
| `resetCommand` | string[] | Argv template |

Placeholders: `{commander}`, `{binary}`, `{ip}`, `{serialno}`, `{chip_type}`.

After substitution, strip empty `--ip` / `--serialno` / `--device` pairs. See [../config/commander-templates.json](../config/commander-templates.json).

### `toolchains`

Default: `["gcc", "gcc_lto", "llvm", "llvm_lto"]`.

### `vcom`

| Field | Default | Notes |
|-------|---------|-------|
| `mode` | `"ip"` | `auto` \| `ip` \| `com` |
| `tcpPort` | `4901` | Silicon Labs adapter UART over Ethernet |
| `baudRate` | `115200` | Local COM only |
| `captureTimeoutSeconds` | `30` | Duration after reset |
| `startupDelaySeconds` | `0.25` | Brief settle before read loop |
| `serialReadTimeoutSeconds` | `0.25` | readline timeout |

### `paths` (under `WORKSPACE_ROOT`)

```
workspace/
  downloads/          # SDK / extension ZIPs
  sdks/<sdkId>/       # extracted Gecko + extension/
  binaries/           # build outputs or imported prebuilts
  logs/<runId>/...
  reports/<runId>.csv
```

Relative dirs in defaults JSON: `downloads`, `sdks`, `binaries`, `logs`, `reports`.

### `discovery`

| Field | Default |
|-------|---------|
| `defaultRootFolder` | `C:\BuildArtifacts\3075` |
| `binaryExtension` | `.s37` |
| `boardNamePattern` | `brd[0-9]+[a-z]+` (case-insensitive) |

### `buildAdapter` (pluggable)

| Field | Notes |
|-------|-------|
| `enabled` | Start `false` until CLI known |
| `slcPath` / `makePath` | Tool paths |
| `generateCommand` / `buildCommand` | Argv templates |

## Recommended Node modules

See [../package-hints/backend-dependencies.md](../package-hints/backend-dependencies.md).

## Seeding on first boot

1. If `settings` collection empty → insert `system-settings.defaults.json` (merge env overrides for `COMMANDER_PATH` / `WORKSPACE_ROOT`).
2. If `boards` empty → insert [../config/boards.seed.json](../config/boards.seed.json).
3. Ensure `WORKSPACE_ROOT` subdirs exist when the worker starts a job (create on demand).

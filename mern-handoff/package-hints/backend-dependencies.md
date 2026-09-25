# Suggested Node.js backend dependencies

Do not install from the Python repo. Add these in the **Node.js** project `package.json` when implementing.

## Core API

| Package | Role |
|---------|------|
| `express` | HTTP API |
| `mongoose` | MongoDB models |
| `cors` | Local React origin |
| `dotenv` | Load `.env` |
| `zod` or `joi` | Request validation |
| `pino` or `winston` | Structured logging |

## Hardware / local I/O

| Package | Role |
|---------|------|
| `serialport` | Local COM VCOM |
| (Node `net`) | TCP VCOM to `ip:4901` |
| (Node `child_process`) | Spawn Commander / build tools — prefer `spawn` without `shell` |
| (Node `fs` / `fs/promises` / `path`) | Workspace files |

## Packages / SDK

| Package | Role |
|---------|------|
| `axios` or `got` | Download ZIPs |
| `adm-zip` or `yauzl` | Extract archives |
| `fs-extra` | Copy extensions into `sdkRoot/extension/` (optional convenience) |

## Reporting / jobs

| Package | Role |
|---------|------|
| `csv-stringify` | CSV execution reports |
| In-process async queue | Sufficient for single-machine v1 |
| `bullmq` + Redis | Only if you later need durable multi-process queues |

## Dev tooling (optional)

| Package | Role |
|---------|------|
| `nodemon` | Backend reload |
| `typescript` + `ts-node` / `tsx` | If using TS |
| `vitest` or `jest` | Unit tests for command formatting / discovery helpers |

## Critical implementation notes

1. **Commander**: build argv arrays; do not concatenate into a shell string when avoidable.
2. **VCOM over IP**: Silicon Labs adapters expose UART on TCP **4901** — use a TCP socket or serialport URL equivalent.
3. **Strip empty flags** after template substitution (`--ip`, `--serialno`, `--device`).
4. **Board lock**: serialize flash/reset/capture per board id.

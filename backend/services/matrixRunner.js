import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import Board from "../models/boards.js";
import System from "../models/system.js";
import { resolveBinaryFromSegments, resolveApplicationFolder } from "./artifactPath.js";
import { withBoardLock } from "./boardLock.js";
import { runFlashResetCapture } from "./hardwareCombo.js";

/**
 * Normalize to string[].
 * Arrays like ["gcc,llvm,gcc_lto"] are split on commas so each toolchain is separate.
 */
export function asStringArray(value) {
    if (value == null || value === "") return [];
    const parts = Array.isArray(value) ? value : [value];
    const out = [];
    for (const part of parts) {
        if (part == null || part === "") continue;
        if (Array.isArray(part)) {
            out.push(...asStringArray(part));
            continue;
        }
        out.push(
            ...String(part)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
        );
    }
    return out;
}

/**
 * Classic: boards × applications × toolchains
 */
export function expandMatrixUnits({ boardIds, applications, toolchains, build }) {
    const boards = asStringArray(boardIds);
    const apps = asStringArray(applications);
    const chains = asStringArray(toolchains);

    if (!boards.length) {
        throw Object.assign(new Error("boardIds is required"), { status: 400 });
    }
    if (!apps.length) {
        throw Object.assign(new Error("applications is required"), { status: 400 });
    }
    if (!chains.length) {
        throw Object.assign(
            new Error("toolchains is required (or configure settings.toolchains)"),
            { status: 400 }
        );
    }
    if (!build || !String(build).trim()) {
        throw Object.assign(new Error("build is required"), { status: 400 });
    }

    const units = [];
    for (const boardId of boards) {
        for (const application of apps) {
            for (const toolchain of chains) {
                units.push({
                    boardId,
                    build: String(build).trim(),
                    application,
                    toolchain,
                });
            }
        }
    }
    return units;
}

/**
 * Per-board jobs: each job has its own application / toolchains / build.
 * Accepts job.toolchain or job.toolchains; job.application or job.applications.
 */
export function expandJobsUnits(jobs, { defaultBuild, defaultToolchains, defaultCaptureTimeoutSeconds } = {}) {
    if (!Array.isArray(jobs) || jobs.length === 0) {
        throw Object.assign(new Error("jobs must be a non-empty array"), { status: 400 });
    }

    const units = [];
    const jobSummaries = [];

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i] ?? {};
        const boardId = job.boardId != null ? String(job.boardId).trim() : "";
        if (!boardId) {
            throw Object.assign(new Error(`jobs[${i}].boardId is required`), {
                status: 400,
            });
        }

        const build = String(job.build ?? defaultBuild ?? "").trim();
        if (!build) {
            throw Object.assign(
                new Error(`jobs[${i}].build is required (or set top-level build)`),
                { status: 400 }
            );
        }

        const apps = asStringArray(job.application ?? job.applications);
        if (!apps.length) {
            throw Object.assign(
                new Error(`jobs[${i}].application is required`),
                { status: 400 }
            );
        }

        const chains = asStringArray(job.toolchain ?? job.toolchains);
        const toolchains = chains.length > 0 ? chains : asStringArray(defaultToolchains);
        if (!toolchains.length) {
            throw Object.assign(
                new Error(
                    `jobs[${i}].toolchain(s) is required (or configure settings.toolchains)`
                ),
                { status: 400 }
            );
        }

        const captureTimeoutSeconds =
            job.captureTimeoutSeconds ?? defaultCaptureTimeoutSeconds;

        jobSummaries.push({
            boardId,
            build,
            applications: apps,
            toolchains,
            captureTimeoutSeconds,
        });

        for (const application of apps) {
            for (const toolchain of toolchains) {
                units.push({
                    boardId,
                    build,
                    application,
                    toolchain,
                    captureTimeoutSeconds,
                });
            }
        }
    }

    return { units, jobSummaries };
}

function skippedResult(unit, board, reason) {
    return {
        flashStatus: "SKIPPED",
        resetStatus: "NOT_RUN",
        captureStatus: "NOT_RUN",
        attempts: 0,
        binaryPath: "",
        binaryFile: "",
        build: unit.build,
        toolchain: unit.toolchain,
        application: unit.application,
        flashArgv: [],
        resetArgv: [],
        flashStdout: "",
        flashStderr: reason,
        resetStdout: "",
        resetStderr: "",
        logFile: "",
        captureBytes: 0,
        vcomEndpoint: "",
        vcomError: "",
        executionTimeSeconds: 0,
        board: board
            ? {
                  id: board._id,
                  name: board.name,
                  ip: board.ip,
                  serialno: board.serialno,
              }
            : { id: unit.boardId, name: "", ip: "", serialno: "" },
        skipReason: reason,
    };
}

async function runOneUnit(board, settings, unit, fallbackCaptureTimeoutSeconds) {
    const root = settings.discovery?.defaultRootFolder || "";
    if (!String(root).trim()) {
        return skippedResult(
            unit,
            board,
            "discovery.defaultRootFolder is not configured"
        );
    }

    let resolved;
    try {
        const applicationFolder = resolveApplicationFolder(
            unit.application,
            board
        );
        resolved = resolveBinaryFromSegments({
            root,
            build: unit.build,
            boardName: board.name,
            toolchain: unit.toolchain,
            application: applicationFolder,
            binaryExtension: settings.discovery?.binaryExtension || ".s37",
        });
        unit = { ...unit, applicationFolder };
    } catch (err) {
        return skippedResult(
            unit,
            board,
            err.message || "Binary not found for this board/toolchain/application"
        );
    }

    const captureTimeoutSeconds =
        unit.captureTimeoutSeconds ?? fallbackCaptureTimeoutSeconds;

    return withBoardLock(String(board._id), async () => {
        const outcome = await runFlashResetCapture({
            board,
            settings,
            binaryPath: resolved.absolutePath,
            binaryFile: resolved.binaryFile,
            build: unit.build,
            toolchain: unit.toolchain,
            application: unit.applicationFolder || unit.application,
            captureTimeoutSeconds,
        });
        return {
            ...outcome,
            application: unit.application,
            applicationFolder: unit.applicationFolder || unit.application,
            board: {
                id: board._id,
                name: board.name,
                ip: board.ip,
                serialno: board.serialno,
            },
        };
    });
}

function csvEscape(value) {
    const s = value == null ? "" : String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function writeRunCsv(reportPath, units) {
    const header = [
        "DateTime",
        "Board",
        "Board_IP",
        "Toolchain",
        "Application",
        "Binary_Name",
        "Flash_Status",
        "Reset_Status",
        "Log_Capture_Status",
        "Log_File",
        "Execution_Time",
        "Build",
    ].join(",");

    const now = new Date().toISOString();
    const rows = units.map((u) =>
        [
            now,
            u.board?.name ?? "",
            u.board?.ip ?? "",
            u.toolchain ?? "",
            u.application ?? "",
            u.binaryFile ?? "",
            u.flashStatus ?? "",
            u.resetStatus ?? "",
            u.captureStatus ?? "",
            u.logFile ?? "",
            u.executionTimeSeconds ?? "",
            u.build ?? "",
        ]
            .map(csvEscape)
            .join(",")
    );

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, [header, ...rows].join("\n"), "utf8");
    return reportPath;
}

async function executeUnits(units, settings, fallbackCaptureTimeoutSeconds) {
    const uniqueBoardIds = [...new Set(units.map((u) => String(u.boardId)))];
    const boardDocs = await Board.find({ _id: { $in: uniqueBoardIds } });
    const boardById = new Map(boardDocs.map((b) => [String(b._id), b]));

    for (const id of uniqueBoardIds) {
        const board = boardById.get(String(id));
        if (!board) {
            const err = new Error(`Board not found: ${id}`);
            err.status = 404;
            throw err;
        }
        if (!board.ip && !board.serialno) {
            const err = new Error(
                `Board ${board.name} requires at least one of ip or serialno`
            );
            err.status = 400;
            throw err;
        }
    }

    const byBoard = new Map();
    for (const unit of units) {
        const key = String(unit.boardId);
        if (!byBoard.has(key)) byBoard.set(key, []);
        byBoard.get(key).push(unit);
    }

    const nested = await Promise.all(
        [...byBoard.entries()].map(async ([boardId, boardUnits]) => {
            const board = boardById.get(boardId);
            const results = [];
            for (const unit of boardUnits) {
                results.push(
                    await runOneUnit(
                        board,
                        settings,
                        unit,
                        fallbackCaptureTimeoutSeconds
                    )
                );
            }
            return results;
        })
    );

    return { results: nested.flat(), uniqueBoardIds };
}

/**
 * Run matrix: parallel across boards, sequential within each board.
 *
 * Supports:
 * 1) Classic: { build, boardIds, applications, toolchains }
 * 2) Jobs: { jobs: [ { boardId, build?, application, toolchain(s), captureTimeoutSeconds? } ] }
 * 3) Raw jobs array passed as `jobs`
 */
export async function runHardwareMatrix(input = {}) {
    const settings = await System.findOne({ key: "system" });
    if (!settings) {
        const err = new Error("System settings are missing");
        err.status = 500;
        throw err;
    }

    const defaultToolchains = [...(settings.toolchains || [])];
    const {
        build,
        boardIds,
        applications,
        toolchains,
        captureTimeoutSeconds,
        jobs: jobsInput,
    } = input;

    let units;
    let mode;
    let jobSummaries = null;
    let responseMeta = {};

    if (Array.isArray(jobsInput) && jobsInput.length > 0) {
        mode = "jobs";
        const expanded = expandJobsUnits(jobsInput, {
            defaultBuild: build,
            defaultToolchains:
                asStringArray(toolchains).length > 0
                    ? asStringArray(toolchains)
                    : defaultToolchains,
            defaultCaptureTimeoutSeconds: captureTimeoutSeconds,
        });
        units = expanded.units;
        jobSummaries = expanded.jobSummaries;
        responseMeta = {
            build: build ? String(build).trim() : undefined,
            jobs: jobSummaries,
        };
    } else {
        mode = "matrix";
        const resolvedToolchains =
            asStringArray(toolchains).length > 0
                ? asStringArray(toolchains)
                : defaultToolchains;

        units = expandMatrixUnits({
            boardIds,
            applications,
            toolchains: resolvedToolchains,
            build,
        });
        responseMeta = {
            build: String(build).trim(),
            boardIds: asStringArray(boardIds),
            applications: asStringArray(applications),
            toolchains: resolvedToolchains,
        };
    }

    const runId = randomUUID();
    const started = Date.now();

    const { results, uniqueBoardIds } = await executeUnits(
        units,
        settings,
        captureTimeoutSeconds
    );

    const workspace =
        settings.paths?.workspaceRoot ||
        process.env.WORKSPACE_ROOT ||
        process.cwd();
    const reportsDir = settings.paths?.reportsDir || "reports";
    const reportsRoot = path.isAbsolute(reportsDir)
        ? reportsDir
        : path.join(String(workspace).trim() || process.cwd(), reportsDir);
    const reportPath = path.join(reportsRoot, `${runId}.csv`);
    writeRunCsv(reportPath, results);

    const summary = {
        total: results.length,
        pass: results.filter((r) => r.flashStatus === "PASS").length,
        fail: results.filter((r) => r.flashStatus === "FAIL").length,
        skipped: results.filter((r) => r.flashStatus === "SKIPPED").length,
        capturePass: results.filter((r) => r.captureStatus === "PASS").length,
        vcomError: results.filter((r) => r.captureStatus === "VCOM_ERROR")
            .length,
    };

    return {
        runId,
        mode,
        ...responseMeta,
        boardIds: uniqueBoardIds,
        parallelBoards: true,
        summary,
        reportPath,
        executionTimeSeconds: (Date.now() - started) / 1000,
        units: results,
    };
}

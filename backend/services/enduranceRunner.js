import fs from "fs";
import path from "path";
import EnduranceRun from "../models/enduranceRun.js";
import Board from "../models/boards.js";
import System from "../models/system.js";
import { withBoardLock } from "./boardLock.js";
import {
    flashBoardFromSegments,
    runResetAndStreamCapture,
} from "./hardwareCombo.js";
import { resolveApplicationFolder } from "./artifactPath.js";

/**
 * In-memory run control (AbortSignal only used during capturing).
 * @type {Map<string, { captureAbort: AbortController, phase: string, cancelRequested: boolean }>}
 */
const runStates = new Map();

function getOrCreateRunState(runId) {
    const key = String(runId);
    let state = runStates.get(key);
    if (!state) {
        state = {
            captureAbort: new AbortController(),
            phase: "idle",
            cancelRequested: false,
        };
        runStates.set(key, state);
    }
    return state;
}

async function setRunPhase(runId, phase, extra = {}) {
    const state = getOrCreateRunState(runId);
    state.phase = phase;
    await EnduranceRun.findByIdAndUpdate(runId, { phase, ...extra });
}

/** Mark QUEUED/RUNNING runs CANCELLED after process restart (no live worker). */
export async function cancelOrphanEnduranceRuns() {
    const orphans = await EnduranceRun.find({
        status: { $in: ["QUEUED", "RUNNING"] },
    });
    let count = 0;
    for (const run of orphans) {
        const reportPath = await finalizeEnduranceReport(
            String(run._id),
            run.units || []
        );
        await EnduranceRun.findByIdAndUpdate(run._id, {
            status: "CANCELLED",
            phase: "idle",
            cancelRequested: true,
            finishedAt: new Date(),
            message: "Cancelled: server restarted while run was active",
            reportPath,
        });
        count += 1;
    }
    return count;
}

function csvEscape(value) {
    const s = value == null ? "" : String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function writeEnduranceCsv(reportPath, runId, units) {
    const header = [
        "DateTime",
        "Run_Id",
        "Job_Index",
        "Board",
        "Build",
        "Toolchain",
        "Application_Folder",
        "Flash_Status",
        "Capture_Status",
        "Duration_Requested_S",
        "Duration_Actual_S",
        "Vcom_Endpoint",
        "Error",
    ].join(",");

    const now = new Date().toISOString();
    const rows = (units || []).map((u) =>
        [
            now,
            runId,
            u.jobIndex ?? "",
            u.boardName ?? "",
            u.build ?? "",
            u.toolchain ?? "",
            u.applicationFolder ?? "",
            u.flashStatus ?? "",
            u.captureStatus ?? "",
            u.durationRequestedSeconds ?? "",
            u.durationActualSeconds ?? "",
            u.vcomEndpoint ?? "",
            u.error ?? "",
        ]
            .map(csvEscape)
            .join(",")
    );

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, [header, ...rows].join("\n"), "utf8");
    return reportPath;
}

async function buildEnduranceReportPath(runId) {
    const settings = await System.findOne({ key: "system" });
    const workspace =
        settings?.paths?.workspaceRoot ||
        process.env.WORKSPACE_ROOT ||
        process.cwd();
    const reportsDir = settings?.paths?.reportsDir || "reports";
    const reportsRoot = path.isAbsolute(reportsDir)
        ? reportsDir
        : path.join(String(workspace).trim() || process.cwd(), reportsDir);
    return path.join(reportsRoot, `endurance_${runId}.csv`);
}

async function finalizeEnduranceReport(runId, units) {
    try {
        const reportPath = await buildEnduranceReportPath(runId);
        writeEnduranceCsv(reportPath, runId, units);
        return reportPath;
    } catch {
        return "";
    }
}

export function resolveJobDurationSeconds(job) {
    if (job.durationSeconds != null && Number(job.durationSeconds) > 0) {
        return Number(job.durationSeconds);
    }
    if (job.durationHours != null && Number(job.durationHours) > 0) {
        return Number(job.durationHours) * 3600;
    }
    throw Object.assign(
        new Error(
            "Each job needs durationSeconds (test) or durationHours (endurance)"
        ),
        { status: 400 }
    );
}

export function validateEnduranceJobs(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) {
        throw Object.assign(new Error("jobs must be a non-empty array"), {
            status: 400,
        });
    }

    const normalized = [];
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i] ?? {};
        const boardIds = Array.isArray(job.boardIds)
            ? job.boardIds.map((id) => String(id).trim()).filter(Boolean)
            : [];
        if (!boardIds.length) {
            throw Object.assign(new Error(`jobs[${i}].boardIds is required`), {
                status: 400,
            });
        }
        const build = String(job.build ?? "").trim();
        const application = String(job.application ?? "").trim();
        const toolchain = String(job.toolchain ?? "").trim();
        if (!build) {
            throw Object.assign(new Error(`jobs[${i}].build is required`), {
                status: 400,
            });
        }
        if (!application) {
            throw Object.assign(
                new Error(`jobs[${i}].application is required`),
                { status: 400 }
            );
        }
        if (!toolchain) {
            throw Object.assign(
                new Error(`jobs[${i}].toolchain is required`),
                { status: 400 }
            );
        }

        const durationSeconds =
            job.durationSeconds != null ? Number(job.durationSeconds) : null;
        const durationHours =
            job.durationHours != null ? Number(job.durationHours) : null;

        resolveJobDurationSeconds({ durationSeconds, durationHours });

        normalized.push({
            boardIds,
            build,
            application,
            applicationByBoard:
                job.applicationByBoard && typeof job.applicationByBoard === "object"
                    ? job.applicationByBoard
                    : null,
            toolchain,
            durationSeconds:
                durationSeconds != null && durationSeconds > 0
                    ? durationSeconds
                    : null,
            durationHours:
                durationHours != null && durationHours > 0
                    ? durationHours
                    : null,
        });
    }
    return normalized;
}

/**
 * Create run document and start background worker (does not await completion).
 */
export async function enqueueEnduranceRun(jobsInput) {
    const jobs = validateEnduranceJobs(jobsInput);

    const allIds = [...new Set(jobs.flatMap((j) => j.boardIds))];
    const boards = await Board.find({ _id: { $in: allIds } });
    const found = new Set(boards.map((b) => String(b._id)));
    for (const id of allIds) {
        if (!found.has(String(id))) {
            throw Object.assign(new Error(`Board not found: ${id}`), {
                status: 404,
            });
        }
    }

    const run = await EnduranceRun.create({
        status: "QUEUED",
        phase: "idle",
        cancelRequested: false,
        jobs,
        currentJobIndex: -1,
        message: "Queued",
        units: [],
    });

    const runId = String(run._id);
    getOrCreateRunState(runId);

    setImmediate(() => {
        runEnduranceWorker(runId).catch(async (err) => {
            try {
                const doc = await EnduranceRun.findById(runId).lean();
                const reportPath = await finalizeEnduranceReport(
                    runId,
                    doc?.units || []
                );
                await EnduranceRun.findByIdAndUpdate(runId, {
                    status: "FAILED",
                    phase: "idle",
                    error: err.message || String(err),
                    finishedAt: new Date(),
                    message: "Failed",
                    reportPath,
                });
            } catch {
                /* ignore */
            } finally {
                runStates.delete(String(runId));
            }
        });
    });

    return { runId, status: "QUEUED" };
}

/**
 * Phase-aware cancel:
 * - Prefer Mongo phase when in-memory state was reset (server restart)
 * - flashing + live worker: soft cancel (do not kill Commander)
 * - flashing + no live worker: cancel immediately (orphan)
 * - capturing / queued / between_jobs: abort capture signal
 */
export async function requestEnduranceCancel(runId) {
    const key = String(runId);
    const run = await EnduranceRun.findById(key);
    if (!run) {
        const err = new Error("Endurance run not found");
        err.status = 404;
        throw err;
    }

    if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) {
        return {
            runId: key,
            status: run.status,
            phase: run.phase,
            deferred: false,
            alreadyFinished: true,
            message: `Run already ${run.status}`,
        };
    }

    const live = runStates.get(key);
    const phase =
        (live && live.phase && live.phase !== "idle" ? live.phase : null) ||
        run.phase ||
        "idle";

    // DB says flashing but no live worker → orphan after restart
    if (phase === "flashing" && !live) {
        const reportPath = await finalizeEnduranceReport(runId, run.units || []);
        await EnduranceRun.findByIdAndUpdate(key, {
            status: "CANCELLED",
            phase: "idle",
            cancelRequested: true,
            finishedAt: new Date(),
            message: "Cancelled: no active worker (likely after restart)",
            reportPath,
        });
        return {
            runId: key,
            status: "CANCELLED",
            phase: "idle",
            deferred: false,
            alreadyFinished: false,
            message: "Run cancelled (worker was not running)",
            reportPath,
        };
    }

    const state = getOrCreateRunState(key);
    state.cancelRequested = true;
    if (phase !== "idle") state.phase = phase;

    if (phase === "flashing") {
        await EnduranceRun.findByIdAndUpdate(key, {
            cancelRequested: true,
            message:
                "Cancel requested — waiting for flash to finish (will not interrupt flash)",
        });
        return {
            runId: key,
            status: run.status,
            phase: "flashing",
            deferred: true,
            alreadyFinished: false,
            message:
                "Cancel accepted; will stop after current flash completes (flash will not be interrupted)",
        };
    }

    if (!state.captureAbort.signal.aborted) {
        state.captureAbort.abort();
    }

    await EnduranceRun.findByIdAndUpdate(key, {
        cancelRequested: true,
        message:
            phase === "capturing"
                ? "Cancel requested — stopping capture"
                : "Cancel requested",
    });

    return {
        runId: key,
        status: run.status,
        phase,
        deferred: false,
        alreadyFinished: false,
        message:
            phase === "capturing"
                ? "Cancel requested; capture will stop shortly"
                : "Cancel requested; worker will stop shortly",
    };
}

function isCancelled(state) {
    return state.cancelRequested || state.captureAbort.signal.aborted;
}

/**
 * Worker: jobs sequential; boards parallel.
 * Per job: flash all boards → (soft cancel check) → VCOM+reset+stream capture.
 * AbortSignal only during capturing — never kills Commander mid-flash.
 */
async function runEnduranceWorker(runId) {
    const key = String(runId);
    const state = getOrCreateRunState(key);

    const run = await EnduranceRun.findById(runId);
    if (!run) {
        runStates.delete(key);
        return;
    }

    if (isCancelled(state)) {
        await EnduranceRun.findByIdAndUpdate(runId, {
            status: "CANCELLED",
            phase: "idle",
            finishedAt: new Date(),
            message: "Cancelled before start",
            cancelRequested: true,
        });
        runStates.delete(key);
        return;
    }

    await EnduranceRun.findByIdAndUpdate(runId, {
        status: "RUNNING",
        phase: "between_jobs",
        startedAt: new Date(),
        message: "Running",
        error: "",
    });
    state.phase = "between_jobs";

    const settings = await System.findOne({ key: "system" });
    if (!settings) {
        throw new Error("System settings are missing");
    }

    const unitResults = [];

    try {
        for (let jobIndex = 0; jobIndex < run.jobs.length; jobIndex++) {
            if (isCancelled(state)) break;

            const job = run.jobs[jobIndex];
            const durationSeconds = resolveJobDurationSeconds(job);

            await EnduranceRun.findByIdAndUpdate(runId, {
                currentJobIndex: jobIndex,
                message: `Job ${jobIndex + 1}/${run.jobs.length}: ${job.application} / ${job.toolchain}`,
            });

            // --- FLASH PHASE (parallel boards; soft cancel only) ---
            await setRunPhase(runId, "flashing", {
                message: `Job ${jobIndex + 1}/${run.jobs.length}: flashing ${job.application} / ${job.toolchain}`,
            });

            const flashByBoardId = new Map();

            await Promise.all(
                job.boardIds.map(async (boardId) => {
                    const board = await Board.findById(boardId);
                    if (!board) {
                        flashByBoardId.set(String(boardId), {
                            boardId: String(boardId),
                            boardName: "",
                            flashStatus: "FAIL",
                            binaryPath: "",
                            binaryFile: "",
                            flashStderr: "Board not found",
                            error: "Board not found",
                        });
                        return;
                    }

                    try {
                        const flash = await withBoardLock(
                            String(board._id),
                            async () =>
                                flashBoardFromSegments({
                                    board,
                                    settings,
                                    build: job.build,
                                    toolchain: job.toolchain,
                                    application: job.application,
                                    applicationByBoard: job.applicationByBoard,
                                })
                        );
                        flashByBoardId.set(String(board._id), {
                            boardId: String(board._id),
                            boardName: board.name,
                            board,
                            ...flash,
                            applicationFolder: flash.applicationFolder || "",
                            error: flash.skipReason || flash.flashStderr || "",
                        });
                    } catch (err) {
                        flashByBoardId.set(String(board._id), {
                            boardId: String(board._id),
                            boardName: board.name,
                            board,
                            flashStatus: "FAIL",
                            binaryPath: "",
                            binaryFile: "",
                            flashStderr: err.message || String(err),
                            error: err.message || String(err),
                        });
                    }
                })
            );

            // Soft cancel after flash: skip capture + remaining jobs
            if (isCancelled(state)) {
                for (const boardId of job.boardIds) {
                    const flash = flashByBoardId.get(String(boardId)) || {};
                    unitResults.push({
                        jobIndex,
                        boardId: String(boardId),
                        boardName: flash.boardName || "",
                        build: job.build,
                        application: job.application,
                        applicationFolder: flash.applicationFolder || "",
                        toolchain: job.toolchain,
                        flashStatus: flash.flashStatus || "NOT_RUN",
                        captureStatus: "NOT_RUN",
                        logFile: "",
                        captureBytes: 0,
                        durationRequestedSeconds: durationSeconds,
                        durationActualSeconds: 0,
                        vcomEndpoint: "",
                        vcomError: "",
                        error:
                            flash.error ||
                            "Cancelled after flash (capture skipped)",
                    });
                }
                await EnduranceRun.findByIdAndUpdate(runId, {
                    units: unitResults,
                });
                break;
            }

            // --- CAPTURE PHASE (parallel; AbortSignal OK) ---
            await setRunPhase(runId, "capturing", {
                message: `Job ${jobIndex + 1}/${run.jobs.length}: capturing ${durationSeconds}s`,
            });

            const captureSignal = state.captureAbort.signal;

            const boardOutcomes = await Promise.all(
                job.boardIds.map(async (boardId) => {
                    const flash = flashByBoardId.get(String(boardId)) || {};
                    const base = {
                        jobIndex,
                        boardId: String(boardId),
                        boardName: flash.boardName || "",
                        build: job.build,
                        application: job.application,
                        applicationFolder: flash.applicationFolder || "",
                        toolchain: job.toolchain,
                        flashStatus: flash.flashStatus || "FAIL",
                        durationRequestedSeconds: durationSeconds,
                    };

                    if (isCancelled(state)) {
                        return {
                            ...base,
                            captureStatus: "NOT_RUN",
                            logFile: "",
                            captureBytes: 0,
                            durationActualSeconds: 0,
                            vcomEndpoint: "",
                            vcomError: "",
                            error: "Cancelled",
                        };
                    }

                    if (flash.flashStatus !== "PASS") {
                        return {
                            ...base,
                            captureStatus: "NOT_RUN",
                            logFile: "",
                            captureBytes: 0,
                            durationActualSeconds: 0,
                            vcomEndpoint: "",
                            vcomError: "",
                            error:
                                flash.error ||
                                flash.flashStderr ||
                                "Flash did not pass",
                        };
                    }

                    const board = flash.board || (await Board.findById(boardId));
                    if (!board) {
                        return {
                            ...base,
                            captureStatus: "FAIL",
                            logFile: "",
                            captureBytes: 0,
                            durationActualSeconds: 0,
                            vcomEndpoint: "",
                            vcomError: "",
                            error: "Board not found",
                        };
                    }

                    let applicationFolder = flash.applicationFolder;
                    if (!applicationFolder) {
                        try {
                            applicationFolder = resolveApplicationFolder(
                                job.application,
                                board,
                                job.applicationByBoard
                            );
                        } catch (err) {
                            return {
                                ...base,
                                captureStatus: "FAIL",
                                logFile: "",
                                captureBytes: 0,
                                durationActualSeconds: 0,
                                vcomEndpoint: "",
                                vcomError: "",
                                error: err.message || String(err),
                            };
                        }
                    }

                    try {
                        const outcome = await withBoardLock(
                            String(board._id),
                            async () =>
                                runResetAndStreamCapture({
                                    board,
                                    settings,
                                    build: job.build,
                                    toolchain: job.toolchain,
                                    application: applicationFolder,
                                    captureTimeoutSeconds: durationSeconds,
                                    signal: captureSignal,
                                })
                        );

                        const cancelledCapture =
                            outcome.aborted ||
                            captureSignal.aborted ||
                            state.cancelRequested;

                        return {
                            ...base,
                            boardName: board.name,
                            applicationFolder,
                            captureStatus: cancelledCapture
                                ? outcome.captureStatus === "PASS"
                                    ? "FAIL"
                                    : outcome.captureStatus
                                : outcome.captureStatus,
                            logFile: outcome.logFile || "",
                            captureBytes: outcome.captureBytes || 0,
                            durationActualSeconds:
                                outcome.durationActualSeconds || 0,
                            vcomEndpoint: outcome.vcomEndpoint || "",
                            vcomError: outcome.vcomError || "",
                            error: cancelledCapture
                                ? "Cancelled during capture"
                                : "",
                        };
                    } catch (err) {
                        return {
                            ...base,
                            boardName: board.name,
                            applicationFolder,
                            captureStatus: "FAIL",
                            logFile: "",
                            captureBytes: 0,
                            durationActualSeconds: 0,
                            vcomEndpoint: "",
                            vcomError: "",
                            error: err.message || String(err),
                        };
                    }
                })
            );

            unitResults.push(...boardOutcomes);
            await EnduranceRun.findByIdAndUpdate(runId, { units: unitResults });

            await setRunPhase(runId, "between_jobs");

            if (isCancelled(state)) break;
        }

        const cancelled = isCancelled(state);
        const reportPath = await finalizeEnduranceReport(runId, unitResults);
        await EnduranceRun.findByIdAndUpdate(runId, {
            status: cancelled ? "CANCELLED" : "COMPLETED",
            phase: "idle",
            finishedAt: new Date(),
            message: cancelled ? "Cancelled" : "Completed",
            units: unitResults,
            currentJobIndex: Math.max(0, run.jobs.length - 1),
            cancelRequested: cancelled,
            reportPath,
        });
    } finally {
        runStates.delete(key);
    }
}

export async function getEnduranceRun(runId) {
    const run = await EnduranceRun.findById(runId).lean();
    if (!run) {
        const err = new Error("Endurance run not found");
        err.status = 404;
        throw err;
    }
    const live = runStates.get(String(runId));
    return {
        runId: String(run._id),
        type: run.type,
        status: run.status,
        phase: live?.phase ?? run.phase,
        cancelRequested: live?.cancelRequested ?? run.cancelRequested,
        jobs: run.jobs,
        currentJobIndex: run.currentJobIndex,
        message: run.message,
        units: run.units,
        error: run.error,
        reportPath: run.reportPath || "",
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
    };
}

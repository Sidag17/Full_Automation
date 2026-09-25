import Board from "../models/boards.js";
import System from "../models/system.js";
import { verifyCommanderPath, runCommanderArgv } from "../services/System.js";
import { buildFlashArgv, buildResetArgv } from "../services/formatCommand.js";
import { resolveBinaryFromSegments, resolveApplicationFolder } from "../services/artifactPath.js";
import { withBoardLock } from "../services/boardLock.js";
import {
    runFlashResetCapture,
    runCaptureOnly,
} from "../services/hardwareCombo.js";
import { runHardwareMatrix } from "../services/matrixRunner.js";

function rejectEmpty(value, label) {
    if (value == null || String(value).trim() === "") {
        return `${label} is required`;
    }
    return null;
}

function boardSummary(board) {
    return {
        id: board._id,
        name: board.name,
        ip: board.ip,
        serialno: board.serialno,
    };
}

async function loadBoardAndSettings(boardId) {
    if (!boardId) {
        const err = new Error("boardId is required");
        err.status = 400;
        throw err;
    }

    const board = await Board.findById(boardId);
    if (!board) {
        const err = new Error("Board not found");
        err.status = 404;
        throw err;
    }

    if (!board.ip && !board.serialno) {
        const err = new Error("Board requires at least one of ip or serialno");
        err.status = 400;
        throw err;
    }

    const settings = await System.findOne({ key: "system" });
    if (!settings) {
        const err = new Error("System settings are missing");
        err.status = 500;
        throw err;
    }

    return { board, settings };
}

function handleHardwareError(res, error) {
    if (error.status) {
        return res.status(error.status).json({ error: error.message });
    }
    if (error.code === "ENOENT") {
        return res.status(404).json({ error: error.message });
    }
    if (
        error.message?.includes("escapes discovery root") ||
        error.message?.includes("path separators") ||
        error.message?.includes("all path segments") ||
        error.message?.includes("binaryPath is required")
    ) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
}

/** POST /api/hardware/flash */
export async function FlashBoard(req, res) {
    try {
        const { boardId, build, toolchain, application, binaryFile } = req.body ?? {};

        for (const [value, label] of [
            [boardId, "boardId"],
            [build, "build"],
            [toolchain, "toolchain"],
            [application, "application"],
        ]) {
            const errMsg = rejectEmpty(value, label);
            if (errMsg) return res.status(400).json({ error: errMsg });
        }

        const { board, settings } = await loadBoardAndSettings(boardId);

        const root = settings.discovery?.defaultRootFolder || "";
        if (!String(root).trim()) {
            return res.status(400).json({
                error: "discovery.defaultRootFolder is not configured",
            });
        }

        let applicationFolder;
        try {
            applicationFolder = resolveApplicationFolder(application, board);
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }

        const resolved = resolveBinaryFromSegments({
            root,
            build,
            boardName: board.name,
            toolchain,
            application: applicationFolder,
            binaryFile,
            binaryExtension: settings.discovery?.binaryExtension || ".s37",
        });

        const commanderPath =
            settings.flashTool?.commanderPath || process.env.COMMANDER_PATH || "";
        const maxAttempts = settings.flashTool?.flashRetryCount ?? 3;
        const timeoutMs = (settings.flashTool?.timeoutSeconds || 120) * 1000;

        if (!verifyCommanderPath(commanderPath)) {
            const argv = buildFlashArgv(settings, board, resolved.absolutePath);
            return res.status(200).json({
                flashStatus: "FAIL",
                attempts: 0,
                binaryPath: resolved.absolutePath,
                binaryFile: resolved.binaryFile,
                build: String(build).trim(),
                toolchain: String(toolchain).trim(),
                application: String(application).trim(),
                applicationFolder,
                argv,
                stdout: "",
                stderr: `Commander not found at ${commanderPath || "(empty path)"}`,
                code: null,
                timedOut: false,
                board: boardSummary(board),
            });
        }

        const outcome = await withBoardLock(String(board._id), async () => {
            let last = null;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const argv = buildFlashArgv(settings, board, resolved.absolutePath);
                last = await runCommanderArgv(argv, timeoutMs);
                last.attempt = attempt;
                if (last.ok) break;
            }
            return last;
        });

        return res.status(200).json({
            flashStatus: outcome.ok ? "PASS" : "FAIL",
            attempts: outcome.attempt,
            binaryPath: resolved.absolutePath,
            binaryFile: resolved.binaryFile,
            build: String(build).trim(),
            toolchain: String(toolchain).trim(),
            application: String(application).trim(),
            applicationFolder,
            argv: outcome.argv,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
            code: outcome.code,
            timedOut: outcome.timedOut,
            board: boardSummary(board),
        });
    } catch (error) {
        return handleHardwareError(res, error);
    }
}

/** POST /api/hardware/reset */
export async function ResetBoard(req, res) {
    try {
        const { boardId } = req.body ?? {};
        const { board, settings } = await loadBoardAndSettings(boardId);

        const commanderPath =
            settings.flashTool?.commanderPath || process.env.COMMANDER_PATH || "";
        const timeoutMs = (settings.flashTool?.timeoutSeconds || 120) * 1000;
        const argv = buildResetArgv(settings, board);

        if (!verifyCommanderPath(commanderPath)) {
            return res.status(200).json({
                resetStatus: "FAIL",
                argv,
                stdout: "",
                stderr: `Commander not found at ${commanderPath || "(empty path)"}`,
                code: null,
                timedOut: false,
                board: boardSummary(board),
            });
        }

        const result = await withBoardLock(String(board._id), async () => {
            return runCommanderArgv(argv, timeoutMs);
        });

        return res.status(200).json({
            resetStatus: result.ok ? "PASS" : "FAIL",
            argv: result.argv,
            stdout: result.stdout,
            stderr: result.stderr,
            code: result.code,
            timedOut: result.timedOut,
            board: boardSummary(board),
        });
    } catch (error) {
        return handleHardwareError(res, error);
    }
}

/** POST /api/hardware/capture */
export async function CaptureBoard(req, res) {
    try {
        const {
            boardId,
            build,
            toolchain,
            application,
            captureTimeoutSeconds,
        } = req.body ?? {};
        const { board, settings } = await loadBoardAndSettings(boardId);

        let applicationFolder = application || "capture";
        try {
            if (application) {
                applicationFolder = resolveApplicationFolder(application, board);
            }
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }

        const outcome = await withBoardLock(String(board._id), async () => {
            return runCaptureOnly({
                board,
                settings,
                build,
                toolchain: toolchain || "unknown",
                application: applicationFolder,
                captureTimeoutSeconds,
            });
        });

        return res.status(200).json({
            ...outcome,
            application: application || "capture",
            applicationFolder,
            board: boardSummary(board),
        });
    } catch (error) {
        return handleHardwareError(res, error);
    }
}

/**
 * POST /api/hardware/flash-reset-capture
 * Order: flash → open VCOM → reset → capture → close VCOM
 */
export async function FlashResetCapture(req, res) {
    try {
        const {
            boardId,
            build,
            toolchain,
            application,
            binaryFile,
            captureTimeoutSeconds,
        } = req.body ?? {};

        for (const [value, label] of [
            [boardId, "boardId"],
            [build, "build"],
            [toolchain, "toolchain"],
            [application, "application"],
        ]) {
            const errMsg = rejectEmpty(value, label);
            if (errMsg) return res.status(400).json({ error: errMsg });
        }

        const { board, settings } = await loadBoardAndSettings(boardId);

        const root = settings.discovery?.defaultRootFolder || "";
        if (!String(root).trim()) {
            return res.status(400).json({
                error: "discovery.defaultRootFolder is not configured",
            });
        }

        let applicationFolder;
        try {
            applicationFolder = resolveApplicationFolder(application, board);
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }

        const resolved = resolveBinaryFromSegments({
            root,
            build,
            boardName: board.name,
            toolchain,
            application: applicationFolder,
            binaryFile,
            binaryExtension: settings.discovery?.binaryExtension || ".s37",
        });

        const outcome = await withBoardLock(String(board._id), async () => {
            return runFlashResetCapture({
                board,
                settings,
                binaryPath: resolved.absolutePath,
                binaryFile: resolved.binaryFile,
                build: String(build).trim(),
                toolchain: String(toolchain).trim(),
                application: applicationFolder,
                captureTimeoutSeconds,
            });
        });

        return res.status(200).json({
            ...outcome,
            application: String(application).trim(),
            applicationFolder,
            board: boardSummary(board),
        });
    } catch (error) {
        return handleHardwareError(res, error);
    }
}

/**
 * POST /api/hardware/runs
 *
 * Classic matrix:
 *   { build, boardIds, applications, toolchains, captureTimeoutSeconds? }
 *
 * Per-board jobs (preferred when apps differ per board):
 *   { jobs: [ { boardId, build?, application, toolchain|toolchains, captureTimeoutSeconds? } ] }
 *   or a raw JSON array of those job objects as the body
 *
 * Parallel across boards; sequential units per board.
 */
export async function StartHardwareRun(req, res) {
    try {
        const body = req.body ?? {};

        // Body may be a raw jobs array
        if (Array.isArray(body)) {
            const result = await runHardwareMatrix({ jobs: body });
            return res.status(200).json(result);
        }

        const {
            build,
            boardIds,
            applications,
            toolchains,
            captureTimeoutSeconds,
            jobs,
        } = body;

        if (Array.isArray(jobs) && jobs.length > 0) {
            const result = await runHardwareMatrix({
                build,
                toolchains,
                captureTimeoutSeconds,
                jobs,
            });
            return res.status(200).json(result);
        }

        if (rejectEmpty(build, "build")) {
            return res.status(400).json({ error: "build is required" });
        }

        const result = await runHardwareMatrix({
            build,
            boardIds,
            applications,
            toolchains,
            captureTimeoutSeconds,
        });

        return res.status(200).json(result);
    } catch (error) {
        return handleHardwareError(res, error);
    }
}

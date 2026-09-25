import { verifyCommanderPath, runCommanderArgv } from "./System.js";
import { buildFlashArgv, buildResetArgv } from "./formatCommand.js";
import {
    openVcom,
    captureVcomToFile,
    closeVcom,
    resolveLogsRoot,
    buildVcomLogPath,
    VcomUnavailableError,
} from "./vcom.js";
import { resolveBinaryFromSegments, resolveApplicationFolder } from "./artifactPath.js";

/**
 * Flash only (retries). Caller should hold board lock.
 * Does not use AbortSignal — never interrupt Commander mid-flash.
 */
export async function flashBoardOnce({
    board,
    settings,
    binaryPath,
    binaryFile,
}) {
    const commanderPath =
        settings.flashTool?.commanderPath || process.env.COMMANDER_PATH || "";
    const maxAttempts = settings.flashTool?.flashRetryCount ?? 3;
    const timeoutMs = (settings.flashTool?.timeoutSeconds || 120) * 1000;

    const result = {
        flashStatus: "FAIL",
        attempts: 0,
        binaryPath: binaryPath || "",
        binaryFile: binaryFile || "",
        flashArgv: [],
        flashStdout: "",
        flashStderr: "",
    };

    if (!binaryPath) {
        result.flashStderr = "binaryPath is required";
        return result;
    }

    if (!verifyCommanderPath(commanderPath)) {
        result.flashArgv = buildFlashArgv(settings, board, binaryPath);
        result.flashStderr = `Commander not found at ${commanderPath || "(empty path)"}`;
        return result;
    }

    let flashLast = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const argv = buildFlashArgv(settings, board, binaryPath);
        flashLast = await runCommanderArgv(argv, timeoutMs);
        result.flashArgv = argv;
        result.attempts = attempt;
        result.flashStdout = flashLast.stdout;
        result.flashStderr = flashLast.stderr;
        if (flashLast.ok) break;
    }

    result.flashStatus = flashLast?.ok ? "PASS" : "FAIL";
    return result;
}

/**
 * Resolve artifact then flash. Returns SKIPPED if binary missing.
 */
export async function flashBoardFromSegments({
    board,
    settings,
    build,
    toolchain,
    application,
    binaryFile,
    applicationByBoard,
}) {
    const root = settings.discovery?.defaultRootFolder || "";
    if (!String(root).trim()) {
        return {
            flashStatus: "SKIPPED",
            attempts: 0,
            binaryPath: "",
            binaryFile: "",
            flashArgv: [],
            flashStdout: "",
            flashStderr: "discovery.defaultRootFolder is not configured",
            skipReason: "discovery.defaultRootFolder is not configured",
            applicationFolder: "",
        };
    }

    let applicationFolder;
    try {
        applicationFolder = resolveApplicationFolder(
            application,
            board,
            applicationByBoard
        );
    } catch (err) {
        return {
            flashStatus: "SKIPPED",
            attempts: 0,
            binaryPath: "",
            binaryFile: "",
            flashArgv: [],
            flashStdout: "",
            flashStderr: err.message || String(err),
            skipReason: err.message || String(err),
            applicationFolder: "",
        };
    }

    let resolved;
    try {
        resolved = resolveBinaryFromSegments({
            root,
            build,
            boardName: board.name,
            toolchain,
            application: applicationFolder,
            binaryFile,
            binaryExtension: settings.discovery?.binaryExtension || ".s37",
        });
    } catch (err) {
        return {
            flashStatus: "SKIPPED",
            attempts: 0,
            binaryPath: "",
            binaryFile: "",
            flashArgv: [],
            flashStdout: "",
            flashStderr: err.message || String(err),
            skipReason: err.message || String(err),
            applicationFolder,
        };
    }

    const flash = await flashBoardOnce({
        board,
        settings,
        binaryPath: resolved.absolutePath,
        binaryFile: resolved.binaryFile,
    });
    return { ...flash, skipReason: "", applicationFolder };
}

/**
 * Open VCOM → reset → stream capture to file.
 * Use AbortSignal only for capture duration (not for flash).
 */
export async function runResetAndStreamCapture({
    board,
    settings,
    build,
    toolchain,
    application,
    captureTimeoutSeconds,
    signal,
}) {
    const timeoutMs = (settings.flashTool?.timeoutSeconds || 120) * 1000;
    const started = Date.now();
    const result = {
        resetStatus: "NOT_RUN",
        captureStatus: "NOT_RUN",
        logFile: "",
        captureBytes: 0,
        durationSeconds: 0,
        durationActualSeconds: 0,
        vcomEndpoint: "",
        vcomError: "",
        aborted: false,
        resetArgv: [],
        resetStdout: "",
        resetStderr: "",
        executionTimeSeconds: 0,
    };

    let session = null;
    try {
        try {
            session = await openVcom(board, settings);
            result.vcomEndpoint = session.endpoint;
        } catch (err) {
            const msg =
                err instanceof VcomUnavailableError
                    ? err.message
                    : err.message || String(err);
            result.vcomError = msg;
            result.captureStatus = "VCOM_ERROR";
            session = null;
        }

        const commanderPath =
            settings.flashTool?.commanderPath || process.env.COMMANDER_PATH || "";
        if (verifyCommanderPath(commanderPath)) {
            const resetArgv = buildResetArgv(settings, board);
            result.resetArgv = resetArgv;
            const resetResult = await runCommanderArgv(resetArgv, timeoutMs);
            result.resetStdout = resetResult.stdout;
            result.resetStderr = resetResult.stderr;
            result.resetStatus = resetResult.ok ? "PASS" : "FAIL";
        } else {
            result.resetStatus = "FAIL";
            result.resetStderr = `Commander not found at ${commanderPath || "(empty path)"}`;
        }

        if (session) {
            const logsRoot = resolveLogsRoot(settings);
            const logPath = buildVcomLogPath(
                logsRoot,
                board.name,
                toolchain,
                application,
                build
            );
            const captured = await captureVcomToFile(session, settings, {
                logPath,
                durationSeconds: captureTimeoutSeconds,
                signal,
            });
            result.logFile = captured.logFile;
            result.captureBytes = captured.bytesWritten;
            result.durationSeconds = captured.durationSeconds;
            result.durationActualSeconds = captured.durationActualSeconds;
            result.aborted = Boolean(captured.aborted);
            result.captureStatus = captured.aborted ? "FAIL" : "PASS";
        }
    } catch (err) {
        result.captureStatus = "FAIL";
        result.vcomError = err.message || String(err);
    } finally {
        await closeVcom(session);
    }

    result.executionTimeSeconds = (Date.now() - started) / 1000;
    return result;
}

/**
 * One-unit combo inside an already-held board lock:
 * flash → open VCOM → reset → capture → close VCOM
 */
export async function runFlashResetCapture({
    board,
    settings,
    binaryPath,
    binaryFile,
    build,
    toolchain,
    application,
    captureTimeoutSeconds,
    signal,
}) {
    const started = Date.now();
    const flash = await flashBoardOnce({
        board,
        settings,
        binaryPath,
        binaryFile,
    });

    const result = {
        flashStatus: flash.flashStatus,
        resetStatus: "NOT_RUN",
        captureStatus: "NOT_RUN",
        attempts: flash.attempts,
        binaryPath: flash.binaryPath,
        binaryFile: flash.binaryFile,
        build,
        toolchain,
        application,
        flashArgv: flash.flashArgv,
        resetArgv: [],
        flashStdout: flash.flashStdout,
        flashStderr: flash.flashStderr,
        resetStdout: "",
        resetStderr: "",
        logFile: "",
        captureBytes: 0,
        vcomEndpoint: "",
        vcomError: "",
        executionTimeSeconds: 0,
    };

    if (flash.flashStatus !== "PASS") {
        result.executionTimeSeconds = (Date.now() - started) / 1000;
        return result;
    }

    const capture = await runResetAndStreamCapture({
        board,
        settings,
        build,
        toolchain,
        application,
        captureTimeoutSeconds,
        signal,
    });

    Object.assign(result, {
        resetStatus: capture.resetStatus,
        captureStatus: capture.captureStatus,
        logFile: capture.logFile,
        captureBytes: capture.captureBytes,
        vcomEndpoint: capture.vcomEndpoint,
        vcomError: capture.vcomError,
        resetArgv: capture.resetArgv,
        resetStdout: capture.resetStdout,
        resetStderr: capture.resetStderr,
        executionTimeSeconds: (Date.now() - started) / 1000,
    });
    return result;
}

/** Capture-only (open VCOM, stream to log file). Caller holds board lock. */
export async function runCaptureOnly({
    board,
    settings,
    build,
    toolchain = "unknown",
    application = "capture",
    captureTimeoutSeconds,
    signal,
}) {
    const started = Date.now();
    let session = null;
    try {
        const logsRoot = resolveLogsRoot(settings);
        const logPath = buildVcomLogPath(
            logsRoot,
            board.name,
            toolchain,
            application,
            build
        );

        session = await openVcom(board, settings);
        const captured = await captureVcomToFile(session, settings, {
            logPath,
            durationSeconds: captureTimeoutSeconds,
            signal,
        });

        return {
            captureStatus: captured.aborted ? "FAIL" : "PASS",
            logFile: captured.logFile,
            captureBytes: captured.bytesWritten,
            durationSeconds: captured.durationSeconds,
            durationActualSeconds: captured.durationActualSeconds,
            streamed: true,
            aborted: Boolean(captured.aborted),
            vcomEndpoint: session.endpoint,
            vcomError: "",
            executionTimeSeconds: (Date.now() - started) / 1000,
        };
    } catch (err) {
        const isVcom =
            err instanceof VcomUnavailableError || err.code === "VCOM_UNAVAILABLE";
        return {
            captureStatus: isVcom ? "VCOM_ERROR" : "FAIL",
            logFile: "",
            captureBytes: 0,
            streamed: true,
            aborted: Boolean(signal?.aborted),
            vcomEndpoint: "",
            vcomError: err.message || String(err),
            executionTimeSeconds: (Date.now() - started) / 1000,
        };
    } finally {
        await closeVcom(session);
    }
}

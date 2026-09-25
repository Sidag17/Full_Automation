import fs from "fs";
import net from "net";
import path from "path";
import { SerialPort } from "serialport";

export class VcomUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "VcomUnavailableError";
        this.code = "VCOM_UNAVAILABLE";
    }
}

/** Resolve logs root: workspaceRoot/logsDir (or absolute logsDir). */
export function resolveLogsRoot(settings) {
    const workspace =
        settings.paths?.workspaceRoot ||
        process.env.WORKSPACE_ROOT ||
        process.cwd();
    const logsDir = settings.paths?.logsDir || "logs";
    return path.isAbsolute(logsDir)
        ? logsDir
        : path.join(String(workspace).trim() || process.cwd(), logsDir);
}

/** logs/<build>/<board>/<toolchain>/<application>/<timestamp>.txt */
export function buildVcomLogPath(logsRoot, boardName, toolchain, application, build) {
    const safe = (s, fallback) =>
        String(s || fallback).replace(/[\\/]/g, "_").trim();

    const stamp = new Date().toISOString().replace(/[:.]/g, "-"); // e.g. 2026-09-23T10-37-05-123Z
    return path.join(
        logsRoot,
        safe(build, "unknown-build"),
        safe(boardName, "board"),
        safe(toolchain, "unknown"),
        safe(application, "capture"),
        `${stamp}.txt`
    );
}

export function writeVcomLog(logPath, content) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, content ?? "", "utf8");
    return logPath;
}

/**
 * Resolve VCOM mode: board.vcomMode override, else settings.vcom.mode (auto|ip|com).
 * @returns {{ kind: "ip"|"com", host?: string, port?: number, comPath?: string, baudRate: number }}
 */
export function resolveVcomEndpoint(board, settings) {
    const vcom = settings.vcom ?? {};
    const mode = String(board.vcomMode || vcom.mode || "auto").toLowerCase().trim();
    const tcpPort = Number(vcom.tcpPort) || 4901;
    const baudRate = Number(board.baudRate) || Number(vcom.baudRate) || 115200;
    const configuredCom = String(board.vcomPort || "").trim();
    const ip = String(board.ip || "").trim();

    if (mode === "ip") {
        if (!ip) {
            throw new VcomUnavailableError(
                `vcom.mode=ip but board ${board.name} has no IP address`
            );
        }
        return { kind: "ip", host: ip, port: tcpPort, baudRate };
    }

    if (mode === "com") {
        if (!configuredCom) {
            throw new VcomUnavailableError(
                `vcom.mode=com but board ${board.name} has no vcomPort`
            );
        }
        return { kind: "com", comPath: configuredCom, baudRate };
    }

    // auto: prefer existing COM, else IP
    if (configuredCom) {
        return { kind: "com", comPath: configuredCom, baudRate };
    }
    if (ip) {
        return { kind: "ip", host: ip, port: tcpPort, baudRate };
    }
    throw new VcomUnavailableError(
        `No VCOM endpoint for ${board.name}. Set ip or vcomPort.`
    );
}

function connectTcp(host, port, connectTimeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        const onConnect = () => {
            cleanup();
            resolve(socket);
        };
        const timer = setTimeout(() => {
            socket.destroy();
            onError(new Error(`TCP connect timeout ${host}:${port}`));
        }, connectTimeoutMs);

        function cleanup() {
            clearTimeout(timer);
            socket.off("error", onError);
            socket.off("connect", onConnect);
        }

        socket.once("error", onError);
        socket.once("connect", onConnect);
    });
}

function openSerialPort(comPath, baudRate) {
    return new Promise((resolve, reject) => {
        const port = new SerialPort({
            path: comPath,
            baudRate,
            autoOpen: false,
        });
        port.open((err) => {
            if (err) reject(err);
            else resolve(port);
        });
    });
}

/**
 * Open VCOM before reset so boot logs are captured.
 * @returns {Promise<{ kind, endpoint, transport, chunks: Buffer[], close: () => Promise<void> }>}
 */
export async function openVcom(board, settings) {
    const endpoint = resolveVcomEndpoint(board, settings);
    const chunks = [];

    if (endpoint.kind === "ip") {
        let socket;
        try {
            socket = await connectTcp(endpoint.host, endpoint.port);
        } catch (err) {
            throw new VcomUnavailableError(
                `Could not open VCOM TCP ${endpoint.host}:${endpoint.port}: ${err.message}`
            );
        }
        socket.on("data", (buf) => chunks.push(Buffer.from(buf)));
        const label = `${endpoint.host}:${endpoint.port}`;
        return {
            kind: "ip",
            endpoint: label,
            transport: socket,
            chunks,
            async close() {
                await new Promise((resolve) => {
                    if (socket.destroyed) return resolve();
                    socket.once("close", resolve);
                    socket.destroy();
                    setTimeout(resolve, 500);
                });
            },
        };
    }

    let port;
    try {
        port = await openSerialPort(endpoint.comPath, endpoint.baudRate);
    } catch (err) {
        throw new VcomUnavailableError(
            `Could not open VCOM COM ${endpoint.comPath}: ${err.message}`
        );
    }
    port.on("data", (buf) => chunks.push(Buffer.from(buf)));
    try {
        port.flush();
    } catch {
        /* ignore */
    }

    return {
        kind: "com",
        endpoint: endpoint.comPath,
        transport: port,
        chunks,
        async close() {
            await new Promise((resolve) => {
                if (!port.isOpen) return resolve();
                port.close(() => resolve());
                setTimeout(resolve, 500);
            });
        },
    };
}

/**
 * Capture for durationMs after optional startup delay. Returns decoded text.
 * Prefer captureVcomToFile for long/endurance runs (streams to disk).
 */
export async function captureVcom(session, settings, durationSeconds) {
    const vcom = settings.vcom ?? {};
    const startupMs = Math.max(0, Number(vcom.startupDelaySeconds ?? 0.25) * 1000);
    const durationMs = Math.max(
        0,
        Number(
            durationSeconds ??
                vcom.captureTimeoutSeconds ??
                process.env.DEFAULT_CAPTURE_TIMEOUT_SECONDS ??
                30
        ) * 1000
    );

    if (startupMs > 0) {
        await new Promise((r) => setTimeout(r, startupMs));
    }

    const startLen = session.chunks.reduce((n, b) => n + b.length, 0);
    await new Promise((r) => setTimeout(r, durationMs));
    const all = Buffer.concat(session.chunks);
    const captured = all.subarray(startLen);
    return {
        text: captured.toString("utf8"),
        bytes: captured.length,
        durationSeconds: durationMs / 1000,
        endpoint: session.endpoint,
    };
}

/**
 * Stream VCOM data to a log file for the given duration (no full in-memory buffer).
 * Safe for long / endurance captures (minutes–hours).
 *
 * @param {object} session - from openVcom
 * @param {object} settings
 * @param {{ logPath: string, durationSeconds?: number, signal?: AbortSignal }} options
 */
export async function captureVcomToFile(session, settings, options = {}) {
    const { logPath, durationSeconds, signal } = options;
    if (!logPath || !String(logPath).trim()) {
        throw new Error("captureVcomToFile: logPath is required");
    }
    if (!session?.transport) {
        throw new Error("captureVcomToFile: VCOM session is not open");
    }

    const vcom = settings.vcom ?? {};
    const startupMs = Math.max(0, Number(vcom.startupDelaySeconds ?? 0.25) * 1000);
    const durationMs = Math.max(
        0,
        Number(
            durationSeconds ??
                vcom.captureTimeoutSeconds ??
                process.env.DEFAULT_CAPTURE_TIMEOUT_SECONDS ??
                30
        ) * 1000
    );

    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const stream = fs.createWriteStream(logPath, { flags: "a" });

    let bytesWritten = 0;
    let streamError = null;

    await new Promise((resolve, reject) => {
        stream.once("open", resolve);
        stream.once("error", reject);
    });

    const onData = (buf) => {
        const chunk = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        bytesWritten += chunk.length;
        stream.write(chunk);
    };

    const onStreamError = (err) => {
        streamError = err;
    };
    stream.on("error", onStreamError);

    const transport = session.transport;
    transport.on("data", onData);

    const startedAt = Date.now();
    let aborted = false;

    const sleep = (ms) =>
        new Promise((resolve) => {
            if (signal?.aborted) {
                aborted = true;
                resolve();
                return;
            }
            const timer = setTimeout(resolve, ms);
            const onAbort = () => {
                aborted = true;
                clearTimeout(timer);
                resolve();
            };
            signal?.addEventListener?.("abort", onAbort, { once: true });
        });

    try {
        if (startupMs > 0) await sleep(startupMs);
        if (!aborted && !signal?.aborted) await sleep(durationMs);
    } finally {
        transport.off("data", onData);
        stream.off("error", onStreamError);
        await new Promise((resolve) => {
            stream.end(() => resolve());
            setTimeout(resolve, 1000);
        });
    }

    if (streamError) {
        throw streamError;
    }

    const actualMs = Date.now() - startedAt;
    return {
        logFile: logPath,
        bytesWritten,
        durationSeconds: durationMs / 1000,
        durationActualSeconds: actualMs / 1000,
        endpoint: session.endpoint,
        aborted: aborted || Boolean(signal?.aborted),
    };
}

export async function closeVcom(session) {
    if (!session) return;
    try {
        await session.close();
    } catch {
        /* ignore close errors */
    }
}

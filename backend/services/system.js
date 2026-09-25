import fs from "fs";
import { SerialPort } from "serialport";
import { spawn } from "child_process";

export function verifyCommanderPath(commanderPath) {
    try {
        if (!commanderPath) return false;
        return fs.existsSync(commanderPath);
    } catch {
        return false;
    }
}

export async function listComPorts() {
    const ports = await SerialPort.list();
    return ports.map((port) => ({
        path: port.path || "",
        manufacturer: port.manufacturer || "",
        serialNumber: port.serialNumber || "",
        vendorId: port.vendorId || "",
        productId: port.productId || "",
    }));
}

export function runCommanderArgv(argv, timeoutMs = 120000) {
    return new Promise((resolve) => {
        if (!argv?.length) {
            resolve({
                ok: false,
                argv: [],
                stdout: "",
                stderr: "empty command",
                code: null,
                timedOut: false,
            });
            return;
        }

        const [cmd, ...args] = argv;
        const child = spawn(cmd, args, { shell: false, windowsHide: true });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);

        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({
                ok: false,
                argv,
                stdout,
                stderr: err.message,
                code: null,
                timedOut: false,
            });
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({
                ok: code === 0 && !timedOut,
                argv,
                stdout,
                stderr: timedOut ? `${stderr}\nprocess timed out`.trim() : stderr,
                code,
                timedOut,
            });
        });
    });
}

/** Probe Commander install: run --version. */
export function runCommanderVersion(commanderPath, timeoutMs = 30000) {
    return runCommanderArgv([commanderPath, "--version"], timeoutMs).then((result) => ({
        exists: true,
        ...result,
    }));
}

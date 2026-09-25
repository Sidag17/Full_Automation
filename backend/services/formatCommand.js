const STRIP_FLAGS = ["--ip", "--serialno", "--device"];

export function formatCommand(template, values, { useDeviceArgument = true } = {}) {
    const vals = {
        commander: values.commander ?? "",
        binary: values.binary ?? "",
        ip: values.ip ?? "",
        serialno: values.serialno ?? "",
        chip_type: useDeviceArgument ? (values.chip_type ?? "") : "",
    };

    const substituted = (template ?? []).map((token) =>
        String(token).replace(/\{(\w+)\}/g, (_, key) => vals[key] ?? "")
    );

    const argv = [];
    for (let i = 0; i < substituted.length; i++) {
        const token = substituted[i];
        if (STRIP_FLAGS.includes(token)) {
            const next = substituted[i + 1];
            if (next === undefined || next === "") {
                i++; // skip flag + empty value
                continue;
            }
        }
        if (token !== "") argv.push(token);
    }
    return argv;
}

/** Prefer --ip when present; only use --serialno for USB-only boards. */
function withSerialnoIfNeeded(template, board) {
    const next = [...(template ?? [])];
    const hasIp = Boolean(String(board?.ip || "").trim());
    // Commander allows only one connection option — never add serialno when IP is set
    if (hasIp) return next;

    if (
        board?.serialno &&
        !next.includes("--serialno") &&
        !next.some((t) => String(t).includes("{serialno}"))
    ) {
        next.push("--serialno", "{serialno}");
    }
    return next;
}

function boardCommandValues(flashTool, board, binary = "") {
    const ip = board.ip || "";
    // If IP is set, force empty serialno so --serialno pairs are stripped
    const serialno = ip ? "" : board.serialno || "";
    return {
        commander: flashTool.commanderPath,
        ip,
        serialno,
        chip_type: board.chipType || "",
        binary,
    };
}

export function buildProbeArgv(settings, board) {
    const flashTool = settings.flashTool ?? {};
    const template = withSerialnoIfNeeded(flashTool.probeCommand, board);

    return formatCommand(template, boardCommandValues(flashTool, board, ""), {
        useDeviceArgument: flashTool.useDeviceArgument !== false,
    });
}

export function buildFlashArgv(settings, board, binaryPath) {
    const flashTool = settings.flashTool ?? {};
    if (!binaryPath || !String(binaryPath).trim()) {
        throw new Error("buildFlashArgv: binaryPath is required");
    }
    const template = withSerialnoIfNeeded(flashTool.flashCommand, board);

    return formatCommand(
        template,
        boardCommandValues(flashTool, board, String(binaryPath).trim()),
        { useDeviceArgument: flashTool.useDeviceArgument !== false }
    );
}

export function buildResetArgv(settings, board) {
    const flashTool = settings.flashTool ?? {};
    const template = withSerialnoIfNeeded(flashTool.resetCommand, board);

    return formatCommand(template, boardCommandValues(flashTool, board, ""), {
        useDeviceArgument: flashTool.useDeviceArgument !== false,
    });
}

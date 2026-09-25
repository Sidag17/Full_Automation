import fs from "fs";
import path from "path";

/**
 * Infer board family from chipType when board.family is empty.
 * efr32* → efr32, SiWG917 / SIWG → siwg917
 */
export function inferBoardFamily(board) {
    const explicit = String(board?.family || "").trim().toLowerCase();
    if (explicit) return explicit;

    const chip = String(board?.chipType || "").toUpperCase();
    if (chip.includes("SIWG917") || chip.includes("SIWX917") || chip.startsWith("SIWG")) {
        return "siwg917";
    }
    if (chip.includes("EFR32") || chip.includes("ZGM") || chip.includes("BGM")) {
        return "efr32";
    }
    return "";
}

/**
 * Resolve application folder template for a board.
 * Placeholders: {board}, {boardName}, {family}
 * Optional per-board override map: applicationByBoard[board.name] or [boardId]
 *
 * Examples:
 *   aiml_soc_model_profiler_efr32_{board}
 *   aiml_soc_blink_{family}_{board}
 */
export function resolveApplicationFolder(template, board, applicationByBoard) {
    const boardName = String(board?.name || "").trim().toLowerCase();
    const boardId = board?._id != null ? String(board._id) : "";

    if (applicationByBoard && typeof applicationByBoard === "object") {
        const override =
            applicationByBoard[boardName] ||
            applicationByBoard[boardId] ||
            applicationByBoard[board?.name];
        if (override != null && String(override).trim() !== "") {
            return String(override).trim();
        }
    }

    const family = inferBoardFamily(board);
    const raw = String(template ?? "").trim();

    if (/\{family\}/i.test(raw) && !family) {
        throw new Error(
            `Board ${boardName || boardId || "?"} needs family (or chipType) to resolve application template: ${template}`
        );
    }

    const resolved = raw
        .replaceAll("{board}", boardName)
        .replaceAll("{boardName}", boardName)
        .replaceAll("{family}", family);

    if (/\{[a-zA-Z_]+\}/.test(resolved)) {
        throw new Error(
            `Unresolved placeholder in application "${template}" for board ${boardName}`
        );
    }

    return resolved;
}

/**
 * Join discovery segments into an absolute binary path.
 * Layout: root / build / boardName / toolchain / application / binaryFile
 */
export function resolveBinaryPath({root,build,boardName,toolchain,application,binaryFile}) {
    const segments = [root, build, boardName, toolchain, application, binaryFile];
    for (const seg of segments) {
        if (seg == null || String(seg).trim() === "") {
            throw new Error("resolveBinaryPath: all path segments are required");
        }
        if (/[\\/]/.test(String(seg).trim()) && seg !== root) {
            throw new Error(`resolveBinaryPath: segment must not contain path separators: ${seg}`);
        }
    }

    const absolutePath = path.resolve(
        path.join(
            String(root).trim(),
            String(build).trim(),
            String(boardName).trim(),
            String(toolchain).trim(),
            String(application).trim(),
            String(binaryFile).trim()
        )
    );

    assertUnderRoot(root, absolutePath);
    return absolutePath;
}

/**
 * Join segments up to the application folder (no binary file).
 */
export function resolveAppFolder({ root, build, boardName, toolchain, application }) {
    const absolutePath = path.resolve(
        path.join(
            String(root ?? "").trim(),
            String(build ?? "").trim(),
            String(boardName ?? "").trim(),
            String(toolchain ?? "").trim(),
            String(application ?? "").trim()
        )
    );
    assertUnderRoot(root, absolutePath);
    return absolutePath;
}

/**
 * Ensure candidate stays under root (blocks .. and other-drive escapes on Windows).
 */
export function assertUnderRoot(root, absolutePath) {
    if (!root || !String(root).trim()) {
        throw new Error("assertUnderRoot: root folder is empty");
    }
    if (!absolutePath || !String(absolutePath).trim()) {
        throw new Error("assertUnderRoot: path is empty");
    }

    const rootResolved = path.resolve(String(root).trim());
    const candidate = path.resolve(String(absolutePath).trim());

    const norm = (p) =>
        process.platform === "win32" ? p.toLowerCase() : p;

    const rootNorm = norm(rootResolved);
    const candidateNorm = norm(candidate);
    const rootWithSep = rootNorm.endsWith(path.sep)
        ? rootNorm
        : rootNorm + path.sep;

    if (candidateNorm !== rootNorm && !candidateNorm.startsWith(rootWithSep)) {
        throw new Error(
            `Path escapes discovery root: ${candidate} is not under ${rootResolved}`
        );
    }

    return candidate;
}

/**
 * Non-recursive listing of a directory under root.
 * @returns {{ dirs: string[], files: string[] }}
 */
export function listChildren(dirPath, root) {
    const absolute = path.resolve(String(dirPath ?? "").trim());
    if (root) {
        assertUnderRoot(root, absolute);
    }

    if (!fs.existsSync(absolute)) {
        const err = new Error(`Directory not found: ${absolute}`);
        err.code = "ENOENT";
        throw err;
    }

    const stat = fs.statSync(absolute);
    if (!stat.isDirectory()) {
        const err = new Error(`Not a directory: ${absolute}`);
        err.code = "ENOTDIR";
        throw err;
    }

    const entries = fs.readdirSync(absolute, { withFileTypes: true });
    const dirs = [];
    const files = [];

    for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) dirs.push(entry.name);
        else if (entry.isFile()) files.push(entry.name);
    }

    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.localeCompare(b));
    return { dirs, files };
}

/**
 * First binary file in folder matching extension (default .s37), sorted by name.
 * @returns {string|null} file name only, or null if none
 */
export function findBinaryInFolder(dirPath, extension = ".s37", root) {
    const ext = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
    const { files } = listChildren(dirPath, root);
    const match = files.find((name) => name.toLowerCase().endsWith(ext));
    return match ?? null;
}

/**
 * Resolve full binary path; if binaryFile omitted, pick first matching extension in the app folder.
 */
export function resolveBinaryFromSegments({
    root,
    build,
    boardName,
    toolchain,
    application,
    binaryFile,
    binaryExtension = ".s37",
}) {
    const appFolder = resolveAppFolder({
        root,
        build,
        boardName,
        toolchain,
        application,
    });

    let fileName = binaryFile;
    if (!fileName || !String(fileName).trim()) {
        fileName = findBinaryInFolder(appFolder, binaryExtension, root);
        if (!fileName) {
            const err = new Error(
                `No binary with extension ${binaryExtension} in ${appFolder}`
            );
            err.code = "ENOENT";
            throw err;
        }
    }

    const absolutePath = resolveBinaryPath({
        root,
        build,
        boardName,
        toolchain,
        application,
        binaryFile: fileName,
    });

    if (!fs.existsSync(absolutePath)) {
        const err = new Error(`Binary not found: ${absolutePath}`);
        err.code = "ENOENT";
        throw err;
    }

    return { absolutePath, binaryFile: fileName, appFolder };
}

import path from "path";
import System from "../models/system.js";
import { listChildren, assertUnderRoot } from "../services/artifactPath.js";

function rejectPathSegment(value, label) {
    if (value == null || String(value).trim() === "") {
        return `${label} is required`;
    }
    if (/[\\/]/.test(String(value).trim())) {
        return `${label} must not contain path separators`;
    }
    return null;
}

async function getDiscoveryRoot() {
    const settings = await System.findOne({ key: "system" });
    if (!settings) {
        const err = new Error("System settings are missing");
        err.status = 500;
        throw err;
    }
    const root = settings.discovery?.defaultRootFolder || "";
    if (!root.trim()) {
        const err = new Error("discovery.defaultRootFolder is not configured");
        err.status = 400;
        throw err;
    }
    return {
        root: String(root).trim(),
        binaryExtension: settings.discovery?.binaryExtension || ".s37",
    };
}

function joinUnderRoot(root, ...segments) {
    const absolute = path.resolve(path.join(root, ...segments.map((s) => String(s).trim())));
    assertUnderRoot(root, absolute);
    return absolute;
}

function handleListError(res, error) {
    if (error.status) {
        return res.status(error.status).json({ error: error.message });
    }
    if (error.code === "ENOENT") {
        return res.status(404).json({ error: error.message });
    }
    if (error.code === "ENOTDIR") {
        return res.status(400).json({ error: error.message });
    }
    if (error.message?.includes("escapes discovery root") ||
        error.message?.includes("path separators") ||
        error.message?.includes("root folder is empty")) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
}

/** GET /api/artifacts/builds */
export async function ListBuilds(req, res) {
    try {
        const { root } = await getDiscoveryRoot();
        const { dirs } = listChildren(root, root);
        return res.status(200).json({ root, items: dirs });
    } catch (error) {
        return handleListError(res, error);
    }
}

/** GET /api/artifacts/boards?build= */
export async function ListArtifactBoards(req, res) {
    try {
        const buildErr = rejectPathSegment(req.query.build, "build");
        if (buildErr) return res.status(400).json({ error: buildErr });

        const { root } = await getDiscoveryRoot();
        const dir = joinUnderRoot(root, req.query.build);
        const { dirs } = listChildren(dir, root);
        return res.status(200).json({
            root,
            build: String(req.query.build).trim(),
            items: dirs,
        });
    } catch (error) {
        return handleListError(res, error);
    }
}

/** GET /api/artifacts/toolchains?build=&board= */
export async function ListToolchains(req, res) {
    try {
        const buildErr = rejectPathSegment(req.query.build, "build");
        const boardErr = rejectPathSegment(req.query.board, "board");
        if (buildErr) return res.status(400).json({ error: buildErr });
        if (boardErr) return res.status(400).json({ error: boardErr });

        const { root } = await getDiscoveryRoot();
        const dir = joinUnderRoot(root, req.query.build, req.query.board);
        const { dirs } = listChildren(dir, root);
        return res.status(200).json({
            root,
            build: String(req.query.build).trim(),
            board: String(req.query.board).trim(),
            items: dirs,
        });
    } catch (error) {
        return handleListError(res, error);
    }
}

/** GET /api/artifacts/apps?build=&board=&toolchain= */
export async function ListApps(req, res) {
    try {
        const buildErr = rejectPathSegment(req.query.build, "build");
        const boardErr = rejectPathSegment(req.query.board, "board");
        const toolchainErr = rejectPathSegment(req.query.toolchain, "toolchain");
        if (buildErr) return res.status(400).json({ error: buildErr });
        if (boardErr) return res.status(400).json({ error: boardErr });
        if (toolchainErr) return res.status(400).json({ error: toolchainErr });

        const { root } = await getDiscoveryRoot();
        const dir = joinUnderRoot(
            root,
            req.query.build,
            req.query.board,
            req.query.toolchain
        );
        const { dirs } = listChildren(dir, root);
        return res.status(200).json({
            root,
            build: String(req.query.build).trim(),
            board: String(req.query.board).trim(),
            toolchain: String(req.query.toolchain).trim(),
            items: dirs,
        });
    } catch (error) {
        return handleListError(res, error);
    }
}

/** GET /api/artifacts/files?build=&board=&toolchain=&application= */
export async function ListFiles(req, res) {
    try {
        const buildErr = rejectPathSegment(req.query.build, "build");
        const boardErr = rejectPathSegment(req.query.board, "board");
        const toolchainErr = rejectPathSegment(req.query.toolchain, "toolchain");
        const appErr = rejectPathSegment(req.query.application, "application");
        if (buildErr) return res.status(400).json({ error: buildErr });
        if (boardErr) return res.status(400).json({ error: boardErr });
        if (toolchainErr) return res.status(400).json({ error: toolchainErr });
        if (appErr) return res.status(400).json({ error: appErr });

        const { root, binaryExtension } = await getDiscoveryRoot();
        const dir = joinUnderRoot(
            root,
            req.query.build,
            req.query.board,
            req.query.toolchain,
            req.query.application
        );
        const { files } = listChildren(dir, root);

        const ext = binaryExtension.startsWith(".")
            ? binaryExtension.toLowerCase()
            : `.${binaryExtension.toLowerCase()}`;
        const binaries = files.filter((name) => name.toLowerCase().endsWith(ext));

        return res.status(200).json({
            root,
            build: String(req.query.build).trim(),
            board: String(req.query.board).trim(),
            toolchain: String(req.query.toolchain).trim(),
            application: String(req.query.application).trim(),
            binaryExtension: ext,
            items: binaries,
            allFiles: files,
        });
    } catch (error) {
        return handleListError(res, error);
    }
}

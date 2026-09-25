import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import AdmZip from "adm-zip";
import SdkPrepareRun from "../models/sdkPrepareRun.js";
import System from "../models/system.js";

/**
 * @type {Map<string, { cancelRequested: boolean, phase: string }>}
 */
const runStates = new Map();

const DEFAULT_SDK_PREPARE = {
    enabled: true,
    defaultExtensions: ["aiml-extension", "wiseconnect"],
    geckoZipName: "gecko-sdk.zip",
    extensionsSubdir: "",
    sdkRootTemplate: "C:\\{build}\\gecko-sdk",
    downloadConcurrency: 4,
};

function getOrCreateRunState(runId) {
    const key = String(runId);
    let state = runStates.get(key);
    if (!state) {
        state = { cancelRequested: false, phase: "idle" };
        runStates.set(key, state);
    }
    return state;
}

function isCancelled(state) {
    return Boolean(state?.cancelRequested);
}

function resolveSdkPrepareConfig(raw) {
    const src = raw?.toObject?.() ?? raw ?? {};
    const out = { ...DEFAULT_SDK_PREPARE, ...src };
    if (!Array.isArray(out.defaultExtensions) || !out.defaultExtensions.length) {
        out.defaultExtensions = [...DEFAULT_SDK_PREPARE.defaultExtensions];
    }
    if (!out.geckoZipName) out.geckoZipName = DEFAULT_SDK_PREPARE.geckoZipName;
    if (!out.sdkRootTemplate) {
        out.sdkRootTemplate = DEFAULT_SDK_PREPARE.sdkRootTemplate;
    }
    const conc = Number(out.downloadConcurrency);
    out.downloadConcurrency =
        Number.isFinite(conc) && conc > 0
            ? Math.floor(conc)
            : DEFAULT_SDK_PREPARE.downloadConcurrency;
    return out;
}

/**
 * Run async tasks with a fixed concurrency pool (same pattern as builds).
 */
async function mapPool(items, concurrency, fn, shouldStop) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Math.max(1, Math.min(concurrency, items.length || 1));

    async function worker() {
        while (true) {
            if (shouldStop?.()) break;
            const idx = next++;
            if (idx >= items.length) break;
            results[idx] = await fn(items[idx], idx);
        }
    }

    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
}

function asStringArray(value) {
    if (value == null) return [];
    if (Array.isArray(value)) {
        return value
            .flatMap((v) => String(v).split(","))
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return String(value)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function applyBuildTemplate(template, build) {
    return String(template || "").replaceAll("{build}", String(build ?? "").trim());
}

function rmrf(target) {
    try {
        if (fs.existsSync(target)) {
            fs.rmSync(target, { recursive: true, force: true });
        }
    } catch {
        /* ignore */
    }
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function pathExists(p) {
    try {
        return Boolean(p) && fs.existsSync(p);
    } catch {
        return false;
    }
}

function dirHasContent(dir) {
    if (!pathExists(dir)) return false;
    try {
        return fs.readdirSync(dir).length > 0;
    } catch {
        return false;
    }
}

/** Convert Artifactory UI URL to downloadable /artifactory/ base. */
export function normalizeArtifactoryBaseUrl(inputUrl) {
    let raw = String(inputUrl ?? "").trim();
    if (!raw) {
        throw Object.assign(new Error("artifactoryUrl is required"), {
            status: 400,
        });
    }

    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw Object.assign(
            new Error("Artifactory URL is not valid (could not parse URL)"),
            { status: 400 }
        );
    }

    if (!/^https?:$/i.test(parsed.protocol)) {
        throw Object.assign(
            new Error("Artifactory URL must start with http:// or https://"),
            { status: 400 }
        );
    }

    let href = parsed.href.replace(/\/+$/, "");
    href = href.replace(/\/ui\/native\//i, "/artifactory/");
    if (!/\/artifactory\//i.test(href) && /artifactory\./i.test(parsed.hostname)) {
        // leave as-is if already a direct file/repo URL without ui/native
    }

    return href.endsWith("/") ? href : `${href}/`;
}

function buildAuthHeaders() {
    const headers = {};
    const token =
        process.env.ARTIFACTORY_TOKEN ||
        process.env.ARTIFACTORY_API_KEY ||
        "";
    const user = process.env.ARTIFACTORY_USER || "";
    const pass =
        process.env.ARTIFACTORY_PASSWORD || process.env.ARTIFACTORY_PASS || "";

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    } else if (user) {
        const basic = Buffer.from(`${user}:${pass}`).toString("base64");
        headers.Authorization = `Basic ${basic}`;
    }
    return headers;
}

async function httpProbe(url, headers) {
    try {
        let res = await fetch(url, {
            method: "HEAD",
            headers,
            redirect: "follow",
        });
        if (res.status === 405 || res.status === 501) {
            res = await fetch(url, {
                method: "GET",
                headers: { ...headers, Range: "bytes=0-0" },
                redirect: "follow",
            });
        }
        return res;
    } catch (err) {
        const e = new Error(
            `Artifactory URL is not reachable: ${err.message || String(err)}`
        );
        e.status = 400;
        e.cause = err;
        throw e;
    }
}

/**
 * Probe gecko-sdk.zip (and optionally list extension candidates).
 * Throws 400 with a clear message if the link / gecko zip is invalid.
 */
export async function validateArtifactoryLink({
    artifactoryUrl,
    geckoZipName = "gecko-sdk.zip",
}) {
    const downloadBaseUrl = normalizeArtifactoryBaseUrl(artifactoryUrl);
    const geckoUrl = new URL(geckoZipName, downloadBaseUrl).href;
    const headers = buildAuthHeaders();

    const res = await httpProbe(geckoUrl, headers);

    if (res.status === 401 || res.status === 403) {
        throw Object.assign(
            new Error(
                `Artifactory rejected credentials for gecko package (HTTP ${res.status}). Set ARTIFACTORY_TOKEN or ARTIFACTORY_USER/PASSWORD.`
            ),
            { status: 401 }
        );
    }

    if (res.status === 404) {
        throw Object.assign(
            new Error(
                `Artifactory link is not valid: ${geckoZipName} was not found at ${geckoUrl}`
            ),
            { status: 400 }
        );
    }

    if (!res.ok) {
        throw Object.assign(
            new Error(
                `Artifactory link is not valid: HTTP ${res.status} for ${geckoUrl}`
            ),
            { status: 400 }
        );
    }

    return { downloadBaseUrl, geckoUrl, ok: true };
}

async function resolveExtensionZipUrl(downloadBaseUrl, extName, preferredSubdir) {
    const headers = buildAuthHeaders();
    const zipName = extName.toLowerCase().endsWith(".zip")
        ? extName
        : `${extName}.zip`;

    const subdirs = [];
    if (preferredSubdir != null && String(preferredSubdir).trim() !== "") {
        subdirs.push(String(preferredSubdir).trim().replace(/^\/+|\/+$/g, ""));
    }
    subdirs.push("", "extensions", "extension");

    const tried = [];
    for (const sub of subdirs) {
        const rel = sub ? `${sub}/${zipName}` : zipName;
        const url = new URL(rel, downloadBaseUrl).href;
        tried.push(url);
        try {
            const res = await httpProbe(url, headers);
            if (res.ok) return url;
            if (res.status === 401 || res.status === 403) {
                throw Object.assign(
                    new Error(
                        `Artifactory rejected credentials for extension ${extName} (HTTP ${res.status})`
                    ),
                    { status: 401 }
                );
            }
        } catch (err) {
            if (err.status === 401) throw err;
            // try next candidate
        }
    }

    throw Object.assign(
        new Error(
            `Extension zip not found for "${extName}". Tried: ${tried.join(", ")}`
        ),
        { status: 400 }
    );
}

async function downloadFile(url, destPath, onProgress) {
    const headers = buildAuthHeaders();
    ensureDir(path.dirname(destPath));

    const res = await fetch(url, { method: "GET", headers, redirect: "follow" });
    if (res.status === 401 || res.status === 403) {
        throw Object.assign(
            new Error(`Download unauthorized (HTTP ${res.status}): ${url}`),
            { status: 401 }
        );
    }
    if (!res.ok) {
        throw Object.assign(
            new Error(`Download failed (HTTP ${res.status}): ${url}`),
            { status: 400 }
        );
    }
    if (!res.body) {
        throw new Error(`Download failed: empty body for ${url}`);
    }

    const nodeStream = Readable.fromWeb(res.body);
    await pipeline(nodeStream, createWriteStream(destPath));
    if (onProgress) onProgress(destPath);
    return destPath;
}

function listTopEntries(dir) {
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.name !== "__MACOSX" && e.name !== ".DS_Store");
}

/**
 * Extract zip into destDir (created). Flattens a single root folder if present.
 */
function extractZipTo(zipPath, destDir, { preferFolderName } = {}) {
    ensureDir(destDir);
    const staging = `${destDir}__staging_${Date.now()}`;
    rmrf(staging);
    ensureDir(staging);

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(staging, true);

    const tops = listTopEntries(staging);
    let source = staging;

    if (tops.length === 1 && tops[0].isDirectory()) {
        source = path.join(staging, tops[0].name);
        if (preferFolderName && tops[0].name !== preferFolderName) {
            // still use inner folder contents
        }
    }

    ensureDir(destDir);
    // Move/copy contents into destDir
    for (const ent of listTopEntries(source)) {
        const from = path.join(source, ent.name);
        const to = path.join(destDir, ent.name);
        fs.cpSync(from, to, { recursive: true });
    }

    rmrf(staging);
    return destDir;
}

function looksLikeGeckoSdk(dir) {
    if (!pathExists(dir)) return false;
    const markers = ["platform", "app", "protocol", "extension", "util"];
    try {
        const names = new Set(fs.readdirSync(dir).map((n) => n.toLowerCase()));
        return markers.some((m) => names.has(m));
    } catch {
        return false;
    }
}

/**
 * Extract gecko zip so result is sdkRoot (…/gecko-sdk).
 */
function extractGeckoSdk(zipPath, sdkRoot) {
    const stagingParent = `${sdkRoot}__extract_${Date.now()}`;
    rmrf(stagingParent);
    ensureDir(stagingParent);

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(stagingParent, true);

    const tops = listTopEntries(stagingParent);
    let geckoSource = stagingParent;

    if (tops.length === 1 && tops[0].isDirectory()) {
        const only = path.join(stagingParent, tops[0].name);
        if (
            tops[0].name.toLowerCase() === "gecko-sdk" ||
            looksLikeGeckoSdk(only)
        ) {
            geckoSource = only;
        }
    } else if (looksLikeGeckoSdk(stagingParent)) {
        geckoSource = stagingParent;
    } else {
        const nested = tops.find(
            (t) =>
                t.isDirectory() &&
                t.name.toLowerCase() === "gecko-sdk"
        );
        if (nested) {
            geckoSource = path.join(stagingParent, nested.name);
        }
    }

    rmrf(sdkRoot);
    ensureDir(path.dirname(sdkRoot));
    fs.cpSync(geckoSource, sdkRoot, { recursive: true });
    rmrf(stagingParent);
    return sdkRoot;
}

export function validatePrepareInput(body, config) {
    const build = String(body?.build ?? "").trim();
    const artifactoryUrl = String(body?.artifactoryUrl ?? "").trim();
    const force = Boolean(body?.force);

    if (!build) {
        throw Object.assign(new Error("build is required"), { status: 400 });
    }
    if (/[\\/]/.test(build)) {
        throw Object.assign(
            new Error("build must be a single folder name (e.g. \"990\"), not a path"),
            { status: 400 }
        );
    }
    if (!artifactoryUrl) {
        throw Object.assign(new Error("artifactoryUrl is required"), {
            status: 400,
        });
    }

    let extensions = asStringArray(body?.extensions ?? body?.extension);
    if (!extensions.length) {
        extensions = asStringArray(config.defaultExtensions);
    }
    // strip .zip suffix for folder naming consistency
    extensions = extensions.map((e) =>
        e.toLowerCase().endsWith(".zip") ? e.slice(0, -4) : e
    );

    let downloadConcurrency = Number(
        body?.downloadConcurrency ?? config.downloadConcurrency ?? 4
    );
    if (!Number.isFinite(downloadConcurrency) || downloadConcurrency < 1) {
        downloadConcurrency = 4;
    }
    downloadConcurrency = Math.min(16, Math.floor(downloadConcurrency));

    return { build, artifactoryUrl, extensions, force, downloadConcurrency };
}

async function setPhase(runId, phase, extra = {}) {
    const state = getOrCreateRunState(runId);
    state.phase = phase;
    await SdkPrepareRun.findByIdAndUpdate(runId, { phase, ...extra });
}

async function runSdkPrepareWorker(runId) {
    const key = String(runId);
    const state = getOrCreateRunState(key);

    const run = await SdkPrepareRun.findById(runId);
    if (!run) {
        runStates.delete(key);
        return;
    }

    const settings = await System.findOne({ key: "system" });
    const config = resolveSdkPrepareConfig(settings?.sdkPrepare);
    const workspace =
        settings?.paths?.workspaceRoot ||
        process.env.WORKSPACE_ROOT ||
        process.cwd();
    const downloadsDir = settings?.paths?.downloadsDir || "downloads";
    const downloadsRoot = path.isAbsolute(downloadsDir)
        ? downloadsDir
        : path.join(String(workspace).trim() || process.cwd(), downloadsDir);

    const sdkRoot = applyBuildTemplate(config.sdkRootTemplate, run.build);
    const buildRoot = path.dirname(sdkRoot);
    const workDir = path.join(downloadsRoot, "sdk-prepare", run.build, key);

    const packages = (run.packages || []).map((p) =>
        typeof p.toObject === "function" ? p.toObject() : { ...p }
    );

    await SdkPrepareRun.findByIdAndUpdate(runId, {
        status: "RUNNING",
        phase: "validating",
        startedAt: new Date(),
        sdkRoot,
        buildRoot,
        message: "Validating Artifactory link",
        packages,
    });

    try {
        if (isCancelled(state)) throw Object.assign(new Error("Cancelled"), { cancelled: true });

        // Already prepared?
        if (
            !run.force &&
            looksLikeGeckoSdk(sdkRoot) &&
            pathExists(path.join(sdkRoot, "extension"))
        ) {
            await SdkPrepareRun.findByIdAndUpdate(runId, {
                status: "COMPLETED",
                phase: "idle",
                finishedAt: new Date(),
                message: `SDK already present at ${sdkRoot} (use force:true to re-download)`,
                packages: packages.map((p) => ({
                    ...p,
                    status: "SKIPPED",
                    error: "Already prepared",
                })),
            });
            return;
        }

        const { downloadBaseUrl, geckoUrl } = await validateArtifactoryLink({
            artifactoryUrl: run.artifactoryUrl,
            geckoZipName: config.geckoZipName,
        });

        await SdkPrepareRun.findByIdAndUpdate(runId, {
            downloadBaseUrl,
            message: "Artifactory link validated",
        });

        if (isCancelled(state)) throw Object.assign(new Error("Cancelled"), { cancelled: true });

        ensureDir(workDir);
        ensureDir(buildRoot);

        // Resolve extension URLs in parallel
        await setPhase(runId, "downloading", {
            message: "Resolving package URLs",
        });

        const resolveConcurrency = Math.max(
            1,
            Number(run.downloadConcurrency) || config.downloadConcurrency || 4
        );

        await mapPool(
            packages,
            resolveConcurrency,
            async (pkg) => {
                if (isCancelled(state)) {
                    throw Object.assign(new Error("Cancelled"), {
                        cancelled: true,
                    });
                }
                if (pkg.kind === "gecko") {
                    pkg.zipUrl = geckoUrl;
                } else {
                    pkg.zipUrl = await resolveExtensionZipUrl(
                        downloadBaseUrl,
                        pkg.name,
                        config.extensionsSubdir
                    );
                }
                return pkg;
            },
            () => isCancelled(state)
        );
        await SdkPrepareRun.findByIdAndUpdate(runId, { packages });

        if (isCancelled(state)) {
            throw Object.assign(new Error("Cancelled"), { cancelled: true });
        }

        // Parallel ZIP downloads (gecko + extensions)
        const downloadConcurrency = Math.max(
            1,
            Number(run.downloadConcurrency) || config.downloadConcurrency || 4
        );
        await setPhase(runId, "downloading", {
            message: `Downloading ${packages.length} package(s) in parallel (concurrency=${downloadConcurrency})`,
        });

        for (const pkg of packages) {
            pkg.status = "DOWNLOADING";
        }
        await SdkPrepareRun.findByIdAndUpdate(runId, { packages });

        const downloadResults = await mapPool(
            packages,
            downloadConcurrency,
            async (pkg) => {
                if (isCancelled(state)) {
                    throw Object.assign(new Error("Cancelled"), {
                        cancelled: true,
                    });
                }
                const zipPath = path.join(
                    workDir,
                    path.basename(pkg.zipUrl || `${pkg.name}.zip`)
                );
                await downloadFile(pkg.zipUrl, zipPath);
                pkg.zipPath = zipPath;
                pkg.status = "DOWNLOADED";
                await SdkPrepareRun.findByIdAndUpdate(runId, {
                    packages,
                    message: `Downloaded ${pkg.name}`,
                });
                return pkg;
            },
            () => isCancelled(state)
        );

        // If cancel stopped the pool early, unfinished stay DOWNLOADING
        for (let i = 0; i < packages.length; i++) {
            if (!downloadResults[i] && packages[i].status === "DOWNLOADING") {
                packages[i].status = "FAILED";
                packages[i].error = "Cancelled during download";
            }
        }
        await SdkPrepareRun.findByIdAndUpdate(runId, { packages });

        if (isCancelled(state)) {
            throw Object.assign(new Error("Cancelled"), { cancelled: true });
        }

        await setPhase(runId, "extracting", { message: "Extracting packages" });

        // Extract gecko
        const geckoPkg = packages.find((p) => p.kind === "gecko");
        if (!geckoPkg?.zipPath) {
            throw new Error("Gecko package missing after download");
        }
        geckoPkg.status = "EXTRACTING";
        await SdkPrepareRun.findByIdAndUpdate(runId, {
            packages,
            message: "Extracting gecko-sdk",
        });

        if (run.force) {
            rmrf(sdkRoot);
        }

        extractGeckoSdk(geckoPkg.zipPath, sdkRoot);
        geckoPkg.targetPath = sdkRoot;
        geckoPkg.status = "OK";
        await SdkPrepareRun.findByIdAndUpdate(runId, { packages });

        await setPhase(runId, "preparing", {
            message: "Installing extensions into gecko-sdk/extension",
        });

        const extensionRoot = path.join(sdkRoot, "extension");
        ensureDir(extensionRoot);

        for (const pkg of packages.filter((p) => p.kind === "extension")) {
            if (isCancelled(state)) {
                throw Object.assign(new Error("Cancelled"), { cancelled: true });
            }
            pkg.status = "EXTRACTING";
            await SdkPrepareRun.findByIdAndUpdate(runId, {
                packages,
                message: `Extracting extension ${pkg.name}`,
            });

            const target = path.join(extensionRoot, pkg.name);
            rmrf(target);
            extractZipTo(pkg.zipPath, target, { preferFolderName: pkg.name });
            pkg.targetPath = target;
            pkg.status = "OK";
            await SdkPrepareRun.findByIdAndUpdate(runId, { packages });
        }

        await setPhase(runId, "cleanup", { message: "Cleaning up ZIP files" });
        for (const pkg of packages) {
            if (pkg.zipPath && pathExists(pkg.zipPath)) {
                try {
                    fs.unlinkSync(pkg.zipPath);
                } catch {
                    /* ignore */
                }
            }
        }
        // remove empty work dir if possible
        try {
            rmrf(workDir);
        } catch {
            /* ignore */
        }

        await SdkPrepareRun.findByIdAndUpdate(runId, {
            status: "COMPLETED",
            phase: "idle",
            finishedAt: new Date(),
            message: `SDK prepared at ${sdkRoot}`,
            packages,
            error: "",
        });
    } catch (err) {
        const cancelled = err.cancelled || isCancelled(state);
        await SdkPrepareRun.findByIdAndUpdate(runId, {
            status: cancelled ? "CANCELLED" : "FAILED",
            phase: "idle",
            finishedAt: new Date(),
            message: cancelled ? "Cancelled" : "Failed",
            error: err.message || String(err),
            packages,
        });
    } finally {
        runStates.delete(key);
    }
}

/** Sync validate endpoint helper */
export async function validateSdkPrepareRequest(body) {
    const settings = await System.findOne({ key: "system" });
    const config = resolveSdkPrepareConfig(settings?.sdkPrepare);
    const input = validatePrepareInput(body, config);
    const link = await validateArtifactoryLink({
        artifactoryUrl: input.artifactoryUrl,
        geckoZipName: config.geckoZipName,
    });

    const sdkRoot = applyBuildTemplate(config.sdkRootTemplate, input.build);
    return {
        ok: true,
        build: input.build,
        artifactoryUrl: input.artifactoryUrl,
        downloadBaseUrl: link.downloadBaseUrl,
        geckoUrl: link.geckoUrl,
        extensions: input.extensions,
        sdkRoot,
        message: "Artifactory link is valid",
    };
}

export async function enqueueSdkPrepare(body) {
    const settings = await System.findOne({ key: "system" });
    const config = resolveSdkPrepareConfig(settings?.sdkPrepare);

    if (config.enabled === false) {
        throw Object.assign(new Error("sdkPrepare.enabled is false"), {
            status: 400,
        });
    }

    const input = validatePrepareInput(body, config);

    // Fail fast on bad link before creating a long run
    const link = await validateArtifactoryLink({
        artifactoryUrl: input.artifactoryUrl,
        geckoZipName: config.geckoZipName,
    });

    const sdkRoot = applyBuildTemplate(config.sdkRootTemplate, input.build);
    const buildRoot = path.dirname(sdkRoot);

    const packages = [
        {
            name: "gecko-sdk",
            kind: "gecko",
            zipUrl: link.geckoUrl,
            zipPath: "",
            status: "PENDING",
            error: "",
            targetPath: sdkRoot,
        },
        ...input.extensions.map((name) => ({
            name,
            kind: "extension",
            zipUrl: "",
            zipPath: "",
            status: "PENDING",
            error: "",
            targetPath: "",
        })),
    ];

    const run = await SdkPrepareRun.create({
        status: "QUEUED",
        phase: "idle",
        cancelRequested: false,
        force: input.force,
        downloadConcurrency: input.downloadConcurrency,
        build: input.build,
        artifactoryUrl: input.artifactoryUrl,
        downloadBaseUrl: link.downloadBaseUrl,
        extensions: input.extensions,
        sdkRoot,
        buildRoot,
        packages,
        message: `Queued (downloadConcurrency=${input.downloadConcurrency})`,
    });

    const runId = String(run._id);
    getOrCreateRunState(runId);

    setImmediate(() => {
        runSdkPrepareWorker(runId).catch(async (err) => {
            try {
                await SdkPrepareRun.findByIdAndUpdate(runId, {
                    status: "FAILED",
                    phase: "idle",
                    error: err.message || String(err),
                    finishedAt: new Date(),
                    message: "Failed",
                });
            } catch {
                /* ignore */
            } finally {
                runStates.delete(runId);
            }
        });
    });

    return {
        runId,
        status: "QUEUED",
        build: input.build,
        sdkRoot,
        extensions: input.extensions,
        downloadBaseUrl: link.downloadBaseUrl,
        downloadConcurrency: input.downloadConcurrency,
    };
}

export async function getSdkPrepareRun(runId) {
    const run = await SdkPrepareRun.findById(runId).lean();
    if (!run) {
        const err = new Error("SDK prepare run not found");
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
        force: run.force,
        downloadConcurrency: run.downloadConcurrency ?? 4,
        build: run.build,
        artifactoryUrl: run.artifactoryUrl,
        downloadBaseUrl: run.downloadBaseUrl,
        extensions: run.extensions,
        sdkRoot: run.sdkRoot,
        buildRoot: run.buildRoot,
        packages: run.packages,
        message: run.message,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
    };
}

export async function requestSdkPrepareCancel(runId) {
    const key = String(runId);
    const run = await SdkPrepareRun.findById(key);
    if (!run) {
        const err = new Error("SDK prepare run not found");
        err.status = 404;
        throw err;
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) {
        return {
            runId: key,
            status: run.status,
            alreadyFinished: true,
            message: `Run already ${run.status}`,
        };
    }

    const live = runStates.get(key);
    if (!live) {
        await SdkPrepareRun.findByIdAndUpdate(key, {
            status: "CANCELLED",
            phase: "idle",
            cancelRequested: true,
            finishedAt: new Date(),
            message: "Cancelled: no active worker",
        });
        return {
            runId: key,
            status: "CANCELLED",
            alreadyFinished: false,
            message: "Run cancelled (worker was not running)",
        };
    }

    live.cancelRequested = true;
    await SdkPrepareRun.findByIdAndUpdate(key, {
        cancelRequested: true,
        message: "Cancel requested",
    });
    return {
        runId: key,
        status: run.status,
        alreadyFinished: false,
        message: "Cancel requested; worker will stop at next checkpoint",
    };
}

export async function cancelOrphanSdkPrepareRuns() {
    const result = await SdkPrepareRun.updateMany(
        { status: { $in: ["QUEUED", "RUNNING"] } },
        {
            $set: {
                status: "CANCELLED",
                phase: "idle",
                cancelRequested: true,
                finishedAt: new Date(),
                message: "Cancelled: server restarted while prepare was active",
            },
        }
    );
    return result.modifiedCount ?? 0;
}

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import BuildRun from "../models/buildRun.js";
import System from "../models/system.js";

/**
 * In-memory run control for cancel + live child processes.
 * @type {Map<string, { cancelRequested: boolean, phase: string, children: Set<import('child_process').ChildProcess> }>}
 */
const runStates = new Map();

const TOOLCHAIN_VARIANTS = {
    gcc: { name: "gcc", compiler: "gcc", extraComponents: [] },
    llvm: { name: "llvm", compiler: "llvm", extraComponents: [] },
    gcc_lto: {
        name: "gcc_lto",
        compiler: "gcc",
        extraComponents: ["toolchain_gcc_lto"],
    },
    llvm_lto: {
        name: "llvm_lto",
        compiler: "llvm",
        extraComponents: ["toolchain_llvm_lto"],
    },
};

const ARTIFACT_EXTS = new Set([".bin", ".hex", ".out", ".s37"]);

/** Fallback tool paths when Mongo buildAdapter fields are empty. */
const DEFAULT_BUILD_ADAPTER = {
    enabled: true,
    slcPath:
        "C:\\Users\\siagrawa\\.silabs\\slt\\installs\\archive\\slc-cli-v6.0.23\\slc_cli\\slc.bat",
    cmakePath:
        "C:\\Users\\siagrawa\\.silabs\\slt\\installs\\conan\\p\\cmakefa35ab0687064\\p\\bin\\cmake.exe",
    ninjaPath:
        "C:\\Users\\siagrawa\\.silabs\\slt\\installs\\conan\\p\\ninja1a38fc85adcf7\\p",
    gccPath:
        "C:\\Users\\siagrawa\\.silabs\\slt\\installs\\conan\\p\\gcc-a999d2e027337f\\p",
    sdkRootTemplate: "C:\\{build}\\gecko-sdk",
    aimlRelative: "extension\\aiml-extension",
    wiseconnectRelative: "extension\\wiseconnect",
    examplesRelative: "extension\\aiml-extension\\examples",
    generateRootTemplate: "C:\\slc-test\\generated\\{build}\\{board}",
    concurrency: 2,
    generateTimeoutSeconds: 600,
    buildTimeoutSeconds: 1800,
};

function resolveBuildAdapter(raw) {
    const src = raw?.toObject?.() ?? raw ?? {};
    const out = { ...DEFAULT_BUILD_ADAPTER, ...src };
    for (const key of Object.keys(DEFAULT_BUILD_ADAPTER)) {
        if (out[key] == null || out[key] === "") {
            out[key] = DEFAULT_BUILD_ADAPTER[key];
        }
    }
    return out;
}

function getOrCreateRunState(runId) {
    const key = String(runId);
    let state = runStates.get(key);
    if (!state) {
        state = {
            cancelRequested: false,
            phase: "idle",
            children: new Set(),
        };
        runStates.set(key, state);
    }
    return state;
}

function isCancelled(state) {
    return Boolean(state?.cancelRequested);
}

function applyTemplate(template, { build, board }) {
    return String(template || "")
        .replaceAll("{build}", String(build ?? "").trim())
        .replaceAll("{board}", String(board ?? "").trim());
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

function resolveToolchainVariant(name) {
    const key = String(name || "")
        .trim()
        .toLowerCase();
    const variant = TOOLCHAIN_VARIANTS[key];
    if (!variant) {
        throw Object.assign(
            new Error(
                `Unknown toolchain "${name}". Use: ${Object.keys(TOOLCHAIN_VARIANTS).join(", ")}`
            ),
            { status: 400 }
        );
    }
    return variant;
}

function csvEscape(value) {
    const s = value == null ? "" : String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function writeBuildCsv(reportPath, runId, units) {
    const header = [
        "DateTime",
        "Run_Id",
        "Job_Index",
        "Build",
        "Board",
        "Project",
        "Toolchain",
        "Compiler",
        "Status",
        "Artifact_Dir",
        "Artifact_Count",
        "Error",
    ].join(",");

    const now = new Date().toISOString();
    const rows = (units || []).map((u) =>
        [
            now,
            runId,
            u.jobIndex ?? "",
            u.build ?? "",
            u.board ?? "",
            u.project ?? "",
            u.toolchain ?? "",
            u.compiler ?? "",
            u.status ?? "",
            u.artifactDir ?? "",
            u.artifactCount ?? "",
            u.error ?? "",
        ]
            .map(csvEscape)
            .join(",")
    );

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, [header, ...rows].join("\n"), "utf8");
    return reportPath;
}

async function buildReportPath(runId) {
    const settings = await System.findOne({ key: "system" });
    const workspace =
        settings?.paths?.workspaceRoot ||
        process.env.WORKSPACE_ROOT ||
        process.cwd();
    const reportsDir = settings?.paths?.reportsDir || "reports";
    const reportsRoot = path.isAbsolute(reportsDir)
        ? reportsDir
        : path.join(String(workspace).trim() || process.cwd(), reportsDir);
    return path.join(reportsRoot, `build_${runId}.csv`);
}

async function finalizeBuildReport(runId, units) {
    try {
        const reportPath = await buildReportPath(runId);
        writeBuildCsv(reportPath, runId, units);
        return reportPath;
    } catch {
        return "";
    }
}

function pathExists(p, type = "any") {
    try {
        if (!p || !fs.existsSync(p)) return false;
        const st = fs.statSync(p);
        if (type === "file") return st.isFile();
        if (type === "dir") return st.isDirectory();
        return true;
    } catch {
        return false;
    }
}

function isFirmwareArtifact(filePath) {
    const name = path.basename(filePath);
    const ext = path.extname(name).toLowerCase();
    if (!ARTIFACT_EXTS.has(ext)) return false;
    // Skip CMake compiler-detection junk under cmake_*/build
    if (/^CMakeDetermineCompilerABI_/i.test(name)) return false;
    if (/^CMakeScratch/i.test(name)) return false;
    return true;
}

function collectArtifacts(dir) {
    const found = [];
    if (!pathExists(dir, "dir")) return found;

    const walk = (d) => {
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of entries) {
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) walk(full);
            else if (ent.isFile() && isFirmwareArtifact(full)) {
                found.push(full);
            }
        }
    };
    walk(dir);
    return found;
}

function copyArtifacts(files, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    const copied = [];
    for (const src of files) {
        const dest = path.join(destDir, path.basename(src));
        fs.copyFileSync(src, dest);
        copied.push(dest);
    }
    return copied;
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

/**
 * Spawn a process; tracks child on run state for cancel.
 */
function runProcess(cmd, args, { cwd, env, timeoutMs, shell, runState } = {}) {
    return new Promise((resolve) => {
        const useShell = Boolean(shell);
        const child = spawn(cmd, args, {
            cwd: cwd || undefined,
            env: env || process.env,
            shell: useShell,
            windowsHide: true,
        });

        if (runState) runState.children.add(child);

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;

        const timer =
            timeoutMs > 0
                ? setTimeout(() => {
                      timedOut = true;
                      try {
                          child.kill();
                      } catch {
                          /* ignore */
                      }
                  }, timeoutMs)
                : null;

        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > 500_000) stdout = stdout.slice(-250_000);
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > 500_000) stderr = stderr.slice(-250_000);
        });

        const finish = (code, errorMessage) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (runState) runState.children.delete(child);
            resolve({
                ok: code === 0 && !timedOut && !errorMessage,
                code,
                timedOut,
                stdout,
                stderr: errorMessage
                    ? `${stderr}\n${errorMessage}`.trim()
                    : timedOut
                      ? `${stderr}\nprocess timed out`.trim()
                      : stderr,
            });
        };

        child.on("error", (err) => finish(null, err.message));
        child.on("close", (code) => finish(code, null));
    });
}

function killRunChildren(state) {
    if (!state?.children) return;
    for (const child of state.children) {
        try {
            child.kill();
        } catch {
            /* ignore */
        }
    }
}

/**
 * Normalize request into jobs[].
 * Supports:
 * 1) { jobs: [ { build, board, projects, toolchains } ] }
 * 2) Flat: { build, board|boards, projects|project, toolchains|toolchain }
 */
export function validateBuildJobs(body) {
    const input = body ?? {};
    let jobsRaw = Array.isArray(input.jobs) ? input.jobs : null;

    if (!jobsRaw) {
        const build = String(input.build ?? "").trim();
        const boards = asStringArray(input.boards ?? input.board);
        const projects = asStringArray(input.projects ?? input.project);
        const toolchains = asStringArray(input.toolchains ?? input.toolchain);
        if (!build || !boards.length || !projects.length || !toolchains.length) {
            throw Object.assign(
                new Error(
                    "Provide jobs[] or flat { build, board(s), project(s), toolchain(s) }"
                ),
                { status: 400 }
            );
        }
        jobsRaw = boards.map((board) => ({
            build,
            board,
            projects,
            toolchains,
        }));
    }

    if (!jobsRaw.length) {
        throw Object.assign(new Error("jobs must be a non-empty array"), {
            status: 400,
        });
    }

    const jobs = [];
    for (let i = 0; i < jobsRaw.length; i++) {
        const job = jobsRaw[i] ?? {};
        const build = String(job.build ?? input.build ?? "").trim();
        const board = String(job.board ?? "").trim().toLowerCase();
        const projects = asStringArray(job.projects ?? job.project);
        const toolchains = asStringArray(job.toolchains ?? job.toolchain);

        if (!build) {
            throw Object.assign(new Error(`jobs[${i}].build is required`), {
                status: 400,
            });
        }
        if (!board) {
            throw Object.assign(new Error(`jobs[${i}].board is required`), {
                status: 400,
            });
        }
        if (!projects.length) {
            throw Object.assign(new Error(`jobs[${i}].projects is required`), {
                status: 400,
            });
        }
        if (!toolchains.length) {
            throw Object.assign(
                new Error(`jobs[${i}].toolchains is required`),
                { status: 400 }
            );
        }

        for (const t of toolchains) resolveToolchainVariant(t);

        jobs.push({ build, board, projects, toolchains });
    }
    return jobs;
}

export function expandBuildUnits(jobs) {
    const units = [];
    jobs.forEach((job, jobIndex) => {
        for (const project of job.projects) {
            for (const toolchainName of job.toolchains) {
                const variant = resolveToolchainVariant(toolchainName);
                units.push({
                    jobIndex,
                    build: job.build,
                    board: job.board,
                    project: String(project).trim(),
                    toolchain: variant.name,
                    compiler: variant.compiler,
                    extraComponents: variant.extraComponents,
                });
            }
        }
    });
    return units;
}

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

function resolveBuildPaths(adapter, discoveryRoot, unit) {
    const sdkRoot = applyTemplate(adapter.sdkRootTemplate, unit);
    const aimlExt = path.join(sdkRoot, adapter.aimlRelative || "extension\\aiml-extension");
    const wiseconnect = path.join(
        sdkRoot,
        adapter.wiseconnectRelative || "extension\\wiseconnect"
    );
    const examplesRoot = path.join(
        sdkRoot,
        adapter.examplesRelative || "extension\\aiml-extension\\examples"
    );
    const generateRoot = applyTemplate(adapter.generateRootTemplate, unit);
    const generateDir = path.join(
        generateRoot,
        unit.toolchain,
        `${unit.project}_${unit.board}`
    );
    const cmakeDir = path.join(generateDir, `cmake_${unit.compiler}`);
    const projectDir = path.join(examplesRoot, unit.project);
    const slcpPath = path.join(projectDir, `${unit.project}.slcp`);

    // Flash/discovery layout:
    // root / build / board / toolchain / {project}_{board}
    // e.g. C:\BuildArtifacts\990\brd2608a\gcc\aiml_soc_blink_efr32_brd2608a
    const applicationFolder = `${unit.project}_${unit.board}`;
    const artifactDir = path.join(
        String(discoveryRoot).trim(),
        unit.build,
        unit.board,
        unit.toolchain,
        applicationFolder
    );

    return {
        sdkRoot,
        aimlExt,
        wiseconnect,
        examplesRoot,
        generateRoot,
        generateDir,
        cmakeDir,
        projectDir,
        slcpPath,
        applicationFolder,
        artifactDir,
    };
}

function validateToolsForUnit(adapter, paths) {
    const missing = [];
    if (!pathExists(adapter.slcPath, "file")) {
        missing.push(`SLC not found: ${adapter.slcPath || "(empty)"}`);
    }
    if (!pathExists(adapter.cmakePath, "file")) {
        missing.push(`CMake not found: ${adapter.cmakePath || "(empty)"}`);
    }
    if (!pathExists(paths.sdkRoot, "dir")) {
        missing.push(`SDK not found: ${paths.sdkRoot}`);
    }
    if (!pathExists(paths.aimlExt, "dir")) {
        missing.push(`AIML extension not found: ${paths.aimlExt}`);
    }
    if (!pathExists(paths.examplesRoot, "dir")) {
        missing.push(`Examples not found: ${paths.examplesRoot}`);
    }
    if (adapter.gccPath && !pathExists(adapter.gccPath, "dir")) {
        missing.push(`GCC not found: ${adapter.gccPath}`);
    }
    if (adapter.ninjaPath && !pathExists(adapter.ninjaPath, "dir")) {
        missing.push(`Ninja not found: ${adapter.ninjaPath}`);
    }
    return missing;
}

async function buildOneUnit(unit, adapter, discoveryRoot, runState, forceRebuild = false) {
    const base = {
        jobIndex: unit.jobIndex,
        build: unit.build,
        board: unit.board,
        project: unit.project,
        toolchain: unit.toolchain,
        compiler: unit.compiler,
        status: "RUNNING",
        generateDir: "",
        artifactDir: "",
        artifactCount: 0,
        artifacts: [],
        error: "",
        generateExitCode: null,
        buildExitCode: null,
    };

    if (isCancelled(runState)) {
        return { ...base, status: "CANCELLED", error: "Cancelled before start" };
    }

    const paths = resolveBuildPaths(adapter, discoveryRoot, unit);
    base.generateDir = paths.generateDir;
    base.artifactDir = paths.artifactDir;

    if (!String(discoveryRoot || "").trim()) {
        return {
            ...base,
            status: "FAILED",
            error: "discovery.defaultRootFolder is empty (artifact output root)",
        };
    }

    const buildOutputDir = path.join(paths.cmakeDir, "build");

    // If generateDir already has firmware, skip SLC/CMake and only copy to BuildArtifacts
    if (!forceRebuild) {
        const existing = collectArtifacts(buildOutputDir);
        if (existing.length > 0) {
            rmrf(paths.artifactDir);
            const copied = copyArtifacts(existing, paths.artifactDir);
            return {
                ...base,
                status: "COPIED_EXISTING",
                artifactCount: copied.length,
                artifacts: copied.map((p) => path.basename(p)),
                error: "Skipped generate/build: firmware already in generateDir; copied to artifactDir",
            };
        }
    }

    const missing = validateToolsForUnit(adapter, paths);
    if (missing.length) {
        return { ...base, status: "FAILED", error: missing.join("; ") };
    }

    if (!pathExists(paths.slcpPath, "file")) {
        return {
            ...base,
            status: "SLCP_NOT_FOUND",
            error: `SLCP not found: ${paths.slcpPath}`,
        };
    }

    const withParts = [unit.board, ...(unit.extraComponents || [])];
    const withValue = withParts.join(",");

    const sdkPaths = [paths.sdkRoot, paths.aimlExt];
    if (pathExists(paths.wiseconnect, "dir")) {
        sdkPaths.push(paths.wiseconnect);
    }

    rmrf(paths.generateDir);
    fs.mkdirSync(paths.generateRoot, { recursive: true });

    const generateArgs = [
        "generate",
        "-d",
        paths.generateDir,
        "--with",
        withValue,
    ];
    for (const p of sdkPaths) {
        generateArgs.push("--sdk-package-path", p);
    }
    generateArgs.push("--force", "-p", paths.slcpPath);

    const genTimeout = (adapter.generateTimeoutSeconds || 600) * 1000;
    const slcIsBat = /\.bat$/i.test(adapter.slcPath);

    const gen = await runProcess(adapter.slcPath, generateArgs, {
        timeoutMs: genTimeout,
        shell: slcIsBat,
        runState,
    });
    base.generateExitCode = gen.code;

    if (isCancelled(runState)) {
        return { ...base, status: "CANCELLED", error: "Cancelled during generate" };
    }

    if (!pathExists(paths.cmakeDir, "dir")) {
        return {
            ...base,
            status: "GENERATION_FAILED",
            error:
                gen.stderr?.slice(0, 2000) ||
                `Generation failed (exit ${gen.code}); cmake_${unit.compiler} missing`,
        };
    }

    const env = { ...process.env };
    if (adapter.gccPath) env.ARM_GCC_DIR = adapter.gccPath;
    if (adapter.ninjaPath) {
        env.PATH = `${adapter.ninjaPath}${path.delimiter}${env.PATH || ""}`;
    }

    const buildTimeout = (adapter.buildTimeoutSeconds || 1800) * 1000;
    const build = await runProcess(
        adapter.cmakePath,
        ["--workflow", "--preset", "project"],
        {
            cwd: paths.cmakeDir,
            env,
            timeoutMs: buildTimeout,
            shell: false,
            runState,
        }
    );
    base.buildExitCode = build.code;

    if (isCancelled(runState)) {
        return { ...base, status: "CANCELLED", error: "Cancelled during build" };
    }

    if (!build.ok) {
        return {
            ...base,
            status: "BUILD_FAILED",
            error:
                build.stderr?.slice(0, 2000) ||
                `CMake build failed (exit ${build.code})`,
        };
    }

    const found = collectArtifacts(buildOutputDir);
    if (!found.length) {
        return {
            ...base,
            status: "NO_ARTIFACTS",
            error: `No firmware files under ${buildOutputDir}`,
        };
    }

    rmrf(paths.artifactDir);
    const copied = copyArtifacts(found, paths.artifactDir);

    return {
        ...base,
        status: "SUCCESS",
        artifactCount: copied.length,
        artifacts: copied.map((p) => path.basename(p)),
        error: "",
    };
}

async function runBuildWorker(runId) {
    const key = String(runId);
    const state = getOrCreateRunState(key);
    state.phase = "building";

    const run = await BuildRun.findById(runId);
    if (!run) {
        runStates.delete(key);
        return;
    }

    const settings = await System.findOne({ key: "system" });
    const adapter = resolveBuildAdapter(settings?.buildAdapter);
    const discoveryRoot =
        settings?.discovery?.defaultRootFolder ||
        process.env.BUILD_ARTIFACT_ROOT ||
        "";

    const concurrency = Math.max(
        1,
        Number(run.concurrency) || Number(adapter.concurrency) || 2
    );

    const unitsPlan = expandBuildUnits(run.jobs);
    const unitResults = unitsPlan.map((u) => ({
        jobIndex: u.jobIndex,
        build: u.build,
        board: u.board,
        project: u.project,
        toolchain: u.toolchain,
        compiler: u.compiler,
        status: "QUEUED",
        generateDir: "",
        artifactDir: "",
        artifactCount: 0,
        artifacts: [],
        error: "",
        generateExitCode: null,
        buildExitCode: null,
    }));

    await BuildRun.findByIdAndUpdate(runId, {
        status: "RUNNING",
        phase: "building",
        startedAt: new Date(),
        message: `Building ${unitsPlan.length} unit(s) (concurrency=${concurrency})`,
        units: unitResults,
    });

    try {
        const results = await mapPool(
            unitsPlan,
            concurrency,
            async (unit, idx) => {
                if (isCancelled(state)) {
                    return {
                        ...unitResults[idx],
                        status: "CANCELLED",
                        error: "Cancelled",
                    };
                }

                unitResults[idx] = {
                    ...unitResults[idx],
                    status: "RUNNING",
                };
                await BuildRun.findByIdAndUpdate(runId, {
                    units: unitResults,
                    message: `Building ${unit.board} / ${unit.project} / ${unit.toolchain}`,
                    phase: "building",
                });

                const outcome = await buildOneUnit(
                    unit,
                    adapter,
                    discoveryRoot,
                    state,
                    Boolean(run.forceRebuild)
                );
                unitResults[idx] = outcome;

                await BuildRun.findByIdAndUpdate(runId, {
                    units: unitResults,
                    phase: "between_units",
                });
                return outcome;
            },
            () => isCancelled(state)
        );

        // Mark any never-started units as cancelled
        for (let i = 0; i < unitResults.length; i++) {
            if (!results[i] && unitResults[i].status === "QUEUED") {
                unitResults[i] = {
                    ...unitResults[i],
                    status: "CANCELLED",
                    error: "Cancelled before start",
                };
            } else if (results[i]) {
                unitResults[i] = results[i];
            }
        }

        const okStatuses = new Set(["SUCCESS", "COPIED_EXISTING"]);
        const successfulBuilds = unitResults.filter((u) =>
            okStatuses.has(u.status)
        ).length;
        const failedBuilds = unitResults.filter(
            (u) =>
                !okStatuses.has(u.status) &&
                !["CANCELLED", "QUEUED"].includes(u.status)
        ).length;
        const cancelled = isCancelled(state);
        const reportPath = await finalizeBuildReport(runId, unitResults);

        const copiedCount = unitResults.filter(
            (u) => u.status === "COPIED_EXISTING"
        ).length;
        await BuildRun.findByIdAndUpdate(runId, {
            status: cancelled ? "CANCELLED" : "COMPLETED",
            phase: "idle",
            finishedAt: new Date(),
            message: cancelled
                ? "Cancelled"
                : `Completed: ${successfulBuilds} ok (${copiedCount} copied existing), ${failedBuilds} failed`,
            units: unitResults,
            successfulBuilds,
            failedBuilds,
            cancelRequested: cancelled,
            reportPath,
        });
    } finally {
        runStates.delete(key);
    }
}

/** Mark QUEUED/RUNNING builds CANCELLED after process restart. */
export async function cancelOrphanBuildRuns() {
    const orphans = await BuildRun.find({
        status: { $in: ["QUEUED", "RUNNING"] },
    });
    let count = 0;
    for (const run of orphans) {
        const reportPath = await finalizeBuildReport(
            String(run._id),
            run.units || []
        );
        await BuildRun.findByIdAndUpdate(run._id, {
            status: "CANCELLED",
            phase: "idle",
            cancelRequested: true,
            finishedAt: new Date(),
            message: "Cancelled: server restarted while build was active",
            reportPath,
        });
        count += 1;
    }
    return count;
}

export async function enqueueBuildRun(body) {
    const settings = await System.findOne({ key: "system" });
    const adapter = resolveBuildAdapter(settings?.buildAdapter);

    if (adapter.enabled === false) {
        throw Object.assign(new Error("buildAdapter.enabled is false"), {
            status: 400,
        });
    }

    const jobs = validateBuildJobs(body);
    const concurrency = Math.max(
        1,
        Number(body?.concurrency) || Number(adapter.concurrency) || 2
    );
    const forceRebuild = Boolean(body?.forceRebuild);

    const unitsPreview = expandBuildUnits(jobs);
    const run = await BuildRun.create({
        status: "QUEUED",
        phase: "idle",
        cancelRequested: false,
        forceRebuild,
        concurrency,
        jobs,
        units: [],
        message: `Queued ${unitsPreview.length} build unit(s)${
            forceRebuild ? " (forceRebuild)" : ""
        }`,
    });

    const runId = String(run._id);
    getOrCreateRunState(runId);

    setImmediate(() => {
        runBuildWorker(runId).catch(async (err) => {
            try {
                const doc = await BuildRun.findById(runId).lean();
                const reportPath = await finalizeBuildReport(
                    runId,
                    doc?.units || []
                );
                await BuildRun.findByIdAndUpdate(runId, {
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

    return {
        runId,
        status: "QUEUED",
        unitCount: unitsPreview.length,
        concurrency,
        forceRebuild,
    };
}

export async function requestBuildCancel(runId) {
    const key = String(runId);
    const run = await BuildRun.findById(key);
    if (!run) {
        const err = new Error("Build run not found");
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
        const reportPath = await finalizeBuildReport(runId, run.units || []);
        await BuildRun.findByIdAndUpdate(key, {
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
            alreadyFinished: false,
            message: "Run cancelled (worker was not running)",
            reportPath,
        };
    }

    live.cancelRequested = true;
    killRunChildren(live);

    await BuildRun.findByIdAndUpdate(key, {
        cancelRequested: true,
        message: "Cancel requested — stopping after current steps",
    });

    return {
        runId: key,
        status: run.status,
        alreadyFinished: false,
        message: "Cancel requested; in-flight generate/build processes will be stopped",
    };
}

export async function getBuildRun(runId) {
    const run = await BuildRun.findById(runId).lean();
    if (!run) {
        const err = new Error("Build run not found");
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
        forceRebuild: Boolean(run.forceRebuild),
        concurrency: run.concurrency,
        jobs: run.jobs,
        units: run.units,
        message: run.message,
        error: run.error,
        reportPath: run.reportPath || "",
        successfulBuilds: run.successfulBuilds,
        failedBuilds: run.failedBuilds,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
    };
}

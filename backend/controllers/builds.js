import fs from "fs";
import {
    enqueueBuildRun,
    getBuildRun,
    requestBuildCancel,
} from "../services/buildRunner.js";
import BuildRun from "../models/buildRun.js";

function handleError(res, error) {
    if (error.status) {
        return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
}

/**
 * POST /api/builds
 *
 * Jobs form:
 * {
 *   jobs: [
 *     { build, board, projects: [], toolchains: [] }
 *   ],
 *   concurrency?: number
 * }
 *
 * Flat form:
 * { build, board|boards, projects|project, toolchains|toolchain, concurrency?, forceRebuild? }
 *
 * If generateDir already has firmware and forceRebuild is false, skips SLC/CMake
 * and only copies into discovery.defaultRootFolder (status COPIED_EXISTING).
 */
export async function StartBuildRun(req, res) {
    try {
        const result = await enqueueBuildRun(req.body ?? {});
        return res.status(202).json({
            ...result,
            message: "Build run queued. Poll GET /api/builds/:runId",
            pollUrl: `/api/builds/${result.runId}`,
        });
    } catch (error) {
        return handleError(res, error);
    }
}

/** GET /api/builds/:id */
export async function GetBuildRun(req, res) {
    try {
        const run = await getBuildRun(req.params.id);
        return res.status(200).json(run);
    } catch (error) {
        return handleError(res, error);
    }
}

/** GET /api/builds */
export async function ListBuildRuns(req, res) {
    try {
        const limit = Math.min(Number(req.query.limit) || 20, 100);
        const runs = await BuildRun.find()
            .sort({ createdAt: -1 })
            .limit(limit)
            .select(
                "status phase cancelRequested concurrency message successfulBuilds failedBuilds reportPath createdAt startedAt finishedAt jobs"
            )
            .lean();
        return res.status(200).json({
            items: runs.map((r) => ({
                runId: String(r._id),
                status: r.status,
                phase: r.phase,
                cancelRequested: r.cancelRequested,
                concurrency: r.concurrency,
                message: r.message,
                jobCount: r.jobs?.length ?? 0,
                successfulBuilds: r.successfulBuilds,
                failedBuilds: r.failedBuilds,
                reportPath: r.reportPath || "",
                createdAt: r.createdAt,
                startedAt: r.startedAt,
                finishedAt: r.finishedAt,
            })),
        });
    } catch (error) {
        return handleError(res, error);
    }
}

/** POST /api/builds/:id/cancel */
export async function CancelBuildRun(req, res) {
    try {
        const result = await requestBuildCancel(req.params.id);
        return res.status(200).json(result);
    } catch (error) {
        return handleError(res, error);
    }
}

/** GET /api/builds/:id/report */
export async function DownloadBuildReport(req, res) {
    try {
        const run = await BuildRun.findById(req.params.id);
        if (!run) {
            return res.status(404).json({ error: "Build run not found" });
        }
        if (!run.reportPath || !fs.existsSync(run.reportPath)) {
            return res.status(404).json({ error: "Report not found" });
        }
        return res.download(run.reportPath);
    } catch (error) {
        return handleError(res, error);
    }
}

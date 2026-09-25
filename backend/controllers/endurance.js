import fs from "fs";
import {
    enqueueEnduranceRun,
    getEnduranceRun,
    requestEnduranceCancel,
} from "../services/enduranceRunner.js";
import EnduranceRun from "../models/enduranceRun.js";

function handleError(res, error) {
    if (error.status) {
        return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
}

/**
 * POST /api/hardware/endurance
 * Body: { jobs: [ { boardIds, build, application, toolchain, durationHours|durationSeconds } ] }
 */
export async function StartEnduranceRun(req, res) {
    try {
        const body = req.body ?? {};
        const jobs = Array.isArray(body) ? body : body.jobs;
        const { runId, status } = await enqueueEnduranceRun(jobs);
        return res.status(202).json({
            runId,
            status,
            message:
                "Endurance run queued. Poll GET /api/hardware/endurance/:runId",
            pollUrl: `/api/hardware/endurance/${runId}`,
        });
    } catch (error) {
        return handleError(res, error);
    }
}

/** GET /api/hardware/endurance/:id */
export async function GetEnduranceRun(req, res) {
    try {
        const { id } = req.params;
        const run = await getEnduranceRun(id);
        return res.status(200).json(run);
    } catch (error) {
        return handleError(res, error);
    }
}

/** GET /api/hardware/endurance — recent runs */
export async function ListEnduranceRuns(req, res) {
    try {
        const limit = Math.min(Number(req.query.limit) || 20, 100);
        const runs = await EnduranceRun.find()
            .sort({ createdAt: -1 })
            .limit(limit)
            .select(
                "status phase cancelRequested currentJobIndex message jobs reportPath createdAt startedAt finishedAt"
            )
            .lean();
        return res.status(200).json({
            items: runs.map((r) => ({
                runId: String(r._id),
                status: r.status,
                phase: r.phase,
                cancelRequested: r.cancelRequested,
                currentJobIndex: r.currentJobIndex,
                message: r.message,
                jobCount: r.jobs?.length ?? 0,
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

/**
 * POST /api/hardware/endurance/:id/cancel
 *
 * Phase-aware:
 * - flashing → soft cancel (wait for flash; do not kill Commander)
 * - capturing / queued / between_jobs → abort capture / stop soon
 * - flashing with no live worker → cancel immediately (orphan)
 */
export async function CancelEnduranceRun(req, res) {
    try {
        const { id } = req.params;
        const result = await requestEnduranceCancel(id);
        return res.status(200).json(result);
    } catch (error) {
        return handleError(res, error);
    }
}

/** GET /api/hardware/endurance/:id/report — download CSV */
export async function DownloadEnduranceReport(req, res) {
    try {
        const run = await EnduranceRun.findById(req.params.id);
        if (!run) {
            return res.status(404).json({ error: "Endurance run not found" });
        }
        if (!run.reportPath || !fs.existsSync(run.reportPath)) {
            return res.status(404).json({ error: "Report not found" });
        }
        return res.download(run.reportPath);
    } catch (error) {
        return handleError(res, error);
    }
}

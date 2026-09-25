import {
    enqueueSdkPrepare,
    getSdkPrepareRun,
    requestSdkPrepareCancel,
    validateSdkPrepareRequest,
} from "../services/sdkPrepare.js";
import SdkPrepareRun from "../models/sdkPrepareRun.js";

function handleError(res, error) {
    if (error.status) {
        return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
}

/**
 * POST /api/sdk/validate
 * Body: { build, artifactoryUrl, extensions? }
 * Checks build + that gecko-sdk.zip is reachable. Does not download.
 */
export async function ValidateSdkPrepare(req, res) {
    try {
        const result = await validateSdkPrepareRequest(req.body ?? {});
        return res.status(200).json(result);
    } catch (error) {
        return handleError(res, error);
    }
}

/**
 * POST /api/sdk/prepare
 * Body: { build, artifactoryUrl, extensions?, force?, downloadConcurrency? }
 */
export async function StartSdkPrepare(req, res) {
    try {
        const result = await enqueueSdkPrepare(req.body ?? {});
        return res.status(202).json({
            ...result,
            message:
                "SDK prepare queued. Poll GET /api/sdk/prepare/:runId",
            pollUrl: `/api/sdk/prepare/${result.runId}`,
        });
    } catch (error) {
        return handleError(res, error);
    }
}

/** GET /api/sdk/prepare/:id */
export async function GetSdkPrepare(req, res) {
    try {
        const run = await getSdkPrepareRun(req.params.id);
        return res.status(200).json(run);
    } catch (error) {
        return handleError(res, error);
    }
}

/** GET /api/sdk/prepare */
export async function ListSdkPrepare(req, res) {
    try {
        const limit = Math.min(Number(req.query.limit) || 20, 100);
        const runs = await SdkPrepareRun.find()
            .sort({ createdAt: -1 })
            .limit(limit)
            .select(
                "status phase build artifactoryUrl extensions sdkRoot message error force createdAt startedAt finishedAt"
            )
            .lean();
        return res.status(200).json({
            items: runs.map((r) => ({
                runId: String(r._id),
                status: r.status,
                phase: r.phase,
                build: r.build,
                artifactoryUrl: r.artifactoryUrl,
                extensions: r.extensions,
                sdkRoot: r.sdkRoot,
                force: r.force,
                message: r.message,
                error: r.error,
                createdAt: r.createdAt,
                startedAt: r.startedAt,
                finishedAt: r.finishedAt,
            })),
        });
    } catch (error) {
        return handleError(res, error);
    }
}

/** POST /api/sdk/prepare/:id/cancel */
export async function CancelSdkPrepare(req, res) {
    try {
        const result = await requestSdkPrepareCancel(req.params.id);
        return res.status(200).json(result);
    } catch (error) {
        return handleError(res, error);
    }
}

import { Router } from "express";
import {
    StartBuildRun,
    GetBuildRun,
    ListBuildRuns,
    CancelBuildRun,
    DownloadBuildReport,
} from "../controllers/builds.js";

const buildsRouter = Router();

buildsRouter.post("/", StartBuildRun);
buildsRouter.get("/", ListBuildRuns);
buildsRouter.get("/:id/report", DownloadBuildReport);
buildsRouter.get("/:id", GetBuildRun);
buildsRouter.post("/:id/cancel", CancelBuildRun);

export default buildsRouter;

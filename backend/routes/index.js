import { Router } from "express";
import healthRouter from "./health.js";
import systemRouter from "./system.js";
import boardsRouter from "./boards.js";
import artifactsRouter from "./artifacts.js";
import hardwareRouter from "./hardware.js";
import buildsRouter from "./builds.js";
import sdkRouter from "./sdk.js";

const IndexRouter = Router();

IndexRouter.use("/health", healthRouter);
IndexRouter.use("/system", systemRouter);
IndexRouter.use("/boards", boardsRouter);

IndexRouter.use("/artifacts", artifactsRouter);
IndexRouter.use("/hardware", hardwareRouter);
IndexRouter.use("/builds", buildsRouter);
IndexRouter.use("/sdk", sdkRouter);

export default IndexRouter;

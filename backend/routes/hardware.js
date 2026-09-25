import { Router } from "express";
import { FlashBoard, ResetBoard, CaptureBoard, FlashResetCapture, StartHardwareRun, } from "../controllers/hardware.js";
import { StartEnduranceRun, GetEnduranceRun, ListEnduranceRuns, CancelEnduranceRun, DownloadEnduranceReport, } from "../controllers/endurance.js";

const hardwareRouter = Router();

hardwareRouter.post("/flash", FlashBoard);
hardwareRouter.post("/reset", ResetBoard);
hardwareRouter.post("/capture", CaptureBoard);
hardwareRouter.post("/flash-reset-capture", FlashResetCapture);
hardwareRouter.post("/runs", StartHardwareRun);

// Endurance (async long-duration)
hardwareRouter.post("/endurance", StartEnduranceRun);
hardwareRouter.get("/endurance", ListEnduranceRuns);
hardwareRouter.get("/endurance/:id/report", DownloadEnduranceReport);
hardwareRouter.get("/endurance/:id", GetEnduranceRun);
hardwareRouter.post("/endurance/:id/cancel", CancelEnduranceRun);

export default hardwareRouter;

import { Router } from "express";
import {
    ValidateSdkPrepare,
    StartSdkPrepare,
    GetSdkPrepare,
    ListSdkPrepare,
    CancelSdkPrepare,
} from "../controllers/sdk.js";

const sdkRouter = Router();

sdkRouter.post("/validate", ValidateSdkPrepare);
sdkRouter.post("/prepare", StartSdkPrepare);
sdkRouter.get("/prepare", ListSdkPrepare);
sdkRouter.get("/prepare/:id", GetSdkPrepare);
sdkRouter.post("/prepare/:id/cancel", CancelSdkPrepare);

export default sdkRouter;

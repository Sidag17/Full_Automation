import { Router } from "express";
import {ListBuilds, ListArtifactBoards,ListToolchains,ListApps,ListFiles,} from "../controllers/artifacts.js";

const artifactsRouter = Router();

artifactsRouter.get("/builds", ListBuilds);
artifactsRouter.get("/boards", ListArtifactBoards);
artifactsRouter.get("/toolchains", ListToolchains);
artifactsRouter.get("/apps", ListApps);
artifactsRouter.get("/files", ListFiles);

export default artifactsRouter;

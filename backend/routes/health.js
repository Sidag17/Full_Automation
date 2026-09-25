import { Router } from "express";
import { HealthOfSystem } from "../controllers/health.js";

const healthRouter = Router();

healthRouter.get('/', HealthOfSystem);

export default healthRouter;
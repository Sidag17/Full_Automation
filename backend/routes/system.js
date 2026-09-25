import { Router } from "express";
import { GetSystemSettings, UpdateSystemSettings, ListComPorts, ProbeCommander } from "../controllers/system.js";

const systemRouter = Router();

systemRouter.get('/settings', GetSystemSettings);
systemRouter.put('/settings', UpdateSystemSettings);

systemRouter.get('/com-ports', ListComPorts);

systemRouter.post('/probe-commander', ProbeCommander);

export default systemRouter;
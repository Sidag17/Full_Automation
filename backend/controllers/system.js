import System from "../models/system.js";
import { listComPorts, verifyCommanderPath, runCommanderVersion } from "../services/system.js";


export async function GetSystemSettings(req, res) {
    try {
        const systemSettings = await System.findOne({ key: "system" });
        if (!systemSettings) return res.status(404).json({ error: "Settings not found" });

        res.status(200).json(systemSettings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function UpdateSystemSettings(req, res) {
    try {
        const systemSettings = await System.findOne({ key: "system" });
        if (!systemSettings) return res.status(404).json({ error: "Settings not found" });

        if (req.body.flashTool) {
            systemSettings.flashTool = {
                ...systemSettings.flashTool.toObject?.() ?? systemSettings.flashTool,
                ...req.body.flashTool,
            };
        }
        if (req.body.vcom) {
            systemSettings.vcom = {
                ...systemSettings.vcom.toObject?.() ?? systemSettings.vcom,
                ...req.body.vcom,
            };
        }
        if (req.body.paths) {
            systemSettings.paths = {
                ...systemSettings.paths.toObject?.() ?? systemSettings.paths,
                ...req.body.paths,
            };
        }
        if (req.body.discovery) {
            systemSettings.discovery = {
                ...systemSettings.discovery.toObject?.() ?? systemSettings.discovery,
                ...req.body.discovery,
            };
        }
        if (req.body.buildAdapter) {
            systemSettings.buildAdapter = {
                ...systemSettings.buildAdapter.toObject?.() ?? systemSettings.buildAdapter,
                ...req.body.buildAdapter,
            };
        }
        if (req.body.sdkPrepare) {
            systemSettings.sdkPrepare = {
                ...systemSettings.sdkPrepare.toObject?.() ?? systemSettings.sdkPrepare,
                ...req.body.sdkPrepare,
            };
        }
        if (req.body.toolchains) {
            systemSettings.toolchains = req.body.toolchains;
        }

        await systemSettings.save();
        res.status(200).json(systemSettings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function ListComPorts(req, res) {
    try {
        const comPorts = await listComPorts();
        if (comPorts.length === 0) return res.status(404).json({ error: "No com ports found" });

        res.status(200).json(comPorts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function ProbeCommander(req, res) {
    try {
        const settings = await System.findOne({ key: "system" });
        const commanderPath = settings?.flashTool?.commanderPath || process.env.COMMANDER_PATH || "";

        if (!verifyCommanderPath(commanderPath)) {
            return res.status(200).json({
                exists: false,
                ok: false,
                argv: [],
                stdout: "",
                stderr: `Commander not found at ${commanderPath || "(empty path)"}`,
                code: null,
            });
        }

        const result = await runCommanderVersion(commanderPath);
        return res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
import { getMongoStatus } from "../models/index.js";
import { verifyCommanderPath } from "../services/system.js";

export function HealthOfSystem(req, res) {
    const commanderPath = process.env.COMMANDER_PATH;
    let data = {
        "ok": false,
        "mongo": true,
        "commanderPath": commanderPath,
        "commanderVerified": true,
    };
    try {
        const mongoStatus = getMongoStatus();
        const commanderVerified = verifyCommanderPath(commanderPath);

        if (!commanderVerified) data.commanderVerified = false;

        if (mongoStatus !== 1) data.mongo = false;

        if (commanderVerified && mongoStatus === 1) data.ok = true;

        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
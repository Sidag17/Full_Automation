import Board from "../models/boards.js";
import System from "../models/system.js";
import { verifyCommanderPath, runCommanderArgv } from "../services/System.js";
import { buildProbeArgv } from "../services/formatCommand.js";

export async function ListBoards(req, res) {
    try {
        const boards = await Board.find().sort({ name: 1 });
        res.status(200).json(boards);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function GetBoard(req, res) {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: "Board ID is required" });

        const board = await Board.findById(id);
        if (!board) return res.status(404).json({ error: "Board not found" });

        res.status(200).json(board);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function CreateBoard(req, res) {
    try {
        const { name, ip, serialno, chipType, family, vcomMode, vcomPort, baudRate, enabled } = req.body;

        const ipValue = ip ?? "";
        const serialnoValue = serialno ?? "";
        if (!ipValue && !serialnoValue) {
            return res.status(400).json({ error: "Provide at least one of ip or serialno" });
        }

        const board = await Board.create({
            name,
            ip: ipValue,
            serialno: serialnoValue,
            chipType,
            family,
            vcomMode,
            vcomPort,
            baudRate,
            enabled,
        });
        res.status(201).json(board);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function UpdateBoard(req, res) {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: "Board ID is required" });

        const board = await Board.findById(id);
        if (!board) return res.status(404).json({ error: "Board not found" });

        const allowed = ["name", "ip", "serialno", "chipType", "family", "vcomMode", "vcomPort", "baudRate", "enabled"];
        for (const key of allowed) {
            if (Object.prototype.hasOwnProperty.call(req.body, key)) {
                board[key] = req.body[key];
            }
        }

        if (!board.ip && !board.serialno) {
            return res.status(400).json({ error: "Provide at least one of ip or serialno" });
        }

        await board.save();
        res.status(200).json(board);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function DeleteBoard(req, res) {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: "Board ID is required" });

        const board = await Board.findByIdAndDelete(id);
        if (!board) return res.status(404).json({ error: "Board not found" });

        res.status(200).json({ ok: true, id: board._id, message: "Board deleted successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function ProbeBoard(req, res) {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: "Board ID is required" });

        const board = await Board.findById(id);
        if (!board) return res.status(404).json({ error: "Board not found" });

        if (!board.ip && !board.serialno) {
            return res.status(400).json({
                error: "Board requires at least one of ip or serialno to probe",
            });
        }

        const settings = await System.findOne({ key: "system" });
        if (!settings) {
            return res.status(500).json({ error: "System settings are missing" });
        }

        const commanderPath =
            settings.flashTool?.commanderPath || process.env.COMMANDER_PATH || "";
        const argv = buildProbeArgv(settings, board);

        if (!verifyCommanderPath(commanderPath)) {
            return res.status(200).json({
                ok: false,
                argv,
                stdout: "",
                stderr: `Commander not found at ${commanderPath || "(empty path)"}`,
            });
        }

        const timeoutMs = (settings.flashTool?.timeoutSeconds || 120) * 1000;
        const result = await runCommanderArgv(argv, timeoutMs);

        return res.status(200).json({
            ok: result.ok,
            argv: result.argv,
            stdout: result.stdout,
            stderr: result.stderr,
            code: result.code,
            timedOut: result.timedOut,
            board: {
                id: board._id,
                name: board.name,
                ip: board.ip,
                serialno: board.serialno,
            },
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

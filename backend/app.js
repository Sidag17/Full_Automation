import express from "express";
import dotenv from "dotenv";
import cors from "cors";

import connectDB from "./models/index.js";
import IndexRouter from "./routes/index.js";
import { cancelOrphanEnduranceRuns } from "./services/enduranceRunner.js";
import { cancelOrphanBuildRuns } from "./services/buildRunner.js";
import { cancelOrphanSdkPrepareRuns } from "./services/sdkPrepare.js";

dotenv.config();

const PORT = process.env.PORT;
const MONGODB_URI = process.env.MONGODB_URI;
const CORS_ORIGIN = process.env.CORS_ORIGIN;

const app = express();

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

app.use("/api", IndexRouter);

app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
});

async function start() {
    await connectDB(MONGODB_URI);
    try {
        const n = await cancelOrphanEnduranceRuns();
        if (n) console.log(`Cancelled ${n} orphan endurance run(s)`);
    } catch (err) {
        console.error("Orphan endurance cleanup failed:", err.message);
    }
    try {
        const n = await cancelOrphanBuildRuns();
        if (n) console.log(`Cancelled ${n} orphan build run(s)`);
    } catch (err) {
        console.error("Orphan build cleanup failed:", err.message);
    }
    try {
        const n = await cancelOrphanSdkPrepareRuns();
        if (n) console.log(`Cancelled ${n} orphan SDK prepare run(s)`);
    } catch (err) {
        console.error("Orphan SDK prepare cleanup failed:", err.message);
    }

    app.listen(PORT, () => {
        console.log(`Server is Runnig at ${PORT}`);
    });
}

start().catch((err) => {
    console.error(err);
    process.exit(1);
});

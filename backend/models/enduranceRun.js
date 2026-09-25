import { Schema, model } from "mongoose";

const enduranceJobSchema = new Schema(
    {
        boardIds: { type: [String], required: true },
        build: { type: String, required: true, trim: true },
        application: { type: String, required: true, trim: true },
        /** Optional map: boardName or boardId → exact application folder */
        applicationByBoard: { type: Schema.Types.Mixed, default: null },
        toolchain: { type: String, required: true, trim: true },
        /** Prefer for tests; if omitted, use durationHours * 3600 */
        durationSeconds: { type: Number, default: null },
        durationHours: { type: Number, default: null },
    },
    { _id: false }
);

const enduranceUnitResultSchema = new Schema(
    {
        jobIndex: { type: Number, default: 0 },
        boardId: { type: String, default: "" },
        boardName: { type: String, default: "" },
        build: { type: String, default: "" },
        application: { type: String, default: "" },
        /** Resolved folder after {board}/{family} substitution */
        applicationFolder: { type: String, default: "" },
        toolchain: { type: String, default: "" },
        flashStatus: {
            type: String,
            default: "NOT_RUN",
        },
        captureStatus: {
            type: String,
            default: "NOT_RUN",
        },
        logFile: { type: String, default: "" },
        captureBytes: { type: Number, default: 0 },
        durationRequestedSeconds: { type: Number, default: 0 },
        durationActualSeconds: { type: Number, default: 0 },
        vcomEndpoint: { type: String, default: "" },
        vcomError: { type: String, default: "" },
        error: { type: String, default: "" },
    },
    { _id: false }
);

const enduranceRunSchema = new Schema(
    {
        type: { type: String, default: "endurance" },
        status: {
            type: String,
            enum: ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"],
            default: "QUEUED",
        },
        /** idle | flashing | capturing | between_jobs */
        phase: {
            type: String,
            enum: ["idle", "flashing", "capturing", "between_jobs"],
            default: "idle",
        },
        /** Soft cancel: never kills an in-progress Commander flash */
        cancelRequested: { type: Boolean, default: false },
        jobs: { type: [enduranceJobSchema], default: [] },
        currentJobIndex: { type: Number, default: -1 },
        message: { type: String, default: "" },
        units: { type: [enduranceUnitResultSchema], default: [] },
        error: { type: String, default: "" },
        reportPath: { type: String, default: "" },
        startedAt: { type: Date, default: null },
        finishedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

const EnduranceRun = model("EnduranceRun", enduranceRunSchema);
export default EnduranceRun;

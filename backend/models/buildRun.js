import { Schema, model } from "mongoose";

const buildJobSchema = new Schema(
    {
        build: { type: String, required: true, trim: true },
        board: { type: String, required: true, trim: true },
        projects: { type: [String], required: true },
        toolchains: { type: [String], required: true },
    },
    { _id: false }
);

const buildUnitResultSchema = new Schema(
    {
        jobIndex: { type: Number, default: 0 },
        build: { type: String, default: "" },
        board: { type: String, default: "" },
        project: { type: String, default: "" },
        toolchain: { type: String, default: "" },
        compiler: { type: String, default: "" },
        status: {
            type: String,
            enum: [
                "QUEUED",
                "RUNNING",
                "SUCCESS",
                "COPIED_EXISTING",
                "SLCP_NOT_FOUND",
                "GENERATION_FAILED",
                "BUILD_FAILED",
                "NO_ARTIFACTS",
                "CANCELLED",
                "FAILED",
            ],
            default: "QUEUED",
        },
        generateDir: { type: String, default: "" },
        artifactDir: { type: String, default: "" },
        artifactCount: { type: Number, default: 0 },
        artifacts: { type: [String], default: [] },
        error: { type: String, default: "" },
        generateExitCode: { type: Number, default: null },
        buildExitCode: { type: Number, default: null },
    },
    { _id: false }
);

const buildRunSchema = new Schema(
    {
        type: { type: String, default: "build" },
        status: {
            type: String,
            enum: ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"],
            default: "QUEUED",
        },
        phase: {
            type: String,
            enum: ["idle", "building", "between_units"],
            default: "idle",
        },
        cancelRequested: { type: Boolean, default: false },
        /** If true, wipe generateDir and rebuild even when firmware already exists */
        forceRebuild: { type: Boolean, default: false },
        concurrency: { type: Number, default: 2 },
        jobs: { type: [buildJobSchema], default: [] },
        units: { type: [buildUnitResultSchema], default: [] },
        message: { type: String, default: "" },
        error: { type: String, default: "" },
        reportPath: { type: String, default: "" },
        successfulBuilds: { type: Number, default: 0 },
        failedBuilds: { type: Number, default: 0 },
        startedAt: { type: Date, default: null },
        finishedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

const BuildRun = model("BuildRun", buildRunSchema);
export default BuildRun;

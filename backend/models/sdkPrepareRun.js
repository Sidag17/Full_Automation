import { Schema, model } from "mongoose";

const packageResultSchema = new Schema(
    {
        name: { type: String, default: "" },
        kind: { type: String, default: "" }, // gecko | extension
        zipUrl: { type: String, default: "" },
        zipPath: { type: String, default: "" },
        status: {
            type: String,
            enum: [
                "PENDING",
                "DOWNLOADING",
                "DOWNLOADED",
                "EXTRACTING",
                "OK",
                "FAILED",
                "SKIPPED",
            ],
            default: "PENDING",
        },
        error: { type: String, default: "" },
        targetPath: { type: String, default: "" },
    },
    { _id: false }
);

const sdkPrepareRunSchema = new Schema(
    {
        type: { type: String, default: "sdk_prepare" },
        status: {
            type: String,
            enum: ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"],
            default: "QUEUED",
        },
        phase: {
            type: String,
            enum: [
                "idle",
                "validating",
                "downloading",
                "extracting",
                "preparing",
                "cleanup",
            ],
            default: "idle",
        },
        cancelRequested: { type: Boolean, default: false },
        force: { type: Boolean, default: false },
        downloadConcurrency: { type: Number, default: 4 },
        build: { type: String, required: true, trim: true },
        artifactoryUrl: { type: String, required: true, trim: true },
        downloadBaseUrl: { type: String, default: "" },
        extensions: { type: [String], default: [] },
        sdkRoot: { type: String, default: "" },
        buildRoot: { type: String, default: "" },
        packages: { type: [packageResultSchema], default: [] },
        message: { type: String, default: "" },
        error: { type: String, default: "" },
        startedAt: { type: Date, default: null },
        finishedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

const SdkPrepareRun = model("SdkPrepareRun", sdkPrepareRunSchema);
export default SdkPrepareRun;

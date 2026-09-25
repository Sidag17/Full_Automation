import { Schema, model } from "mongoose";

const flashToolSchema = new Schema(
    {
        commanderPath: { type: String, default: "" },
        timeoutSeconds: { type: Number, default: 120 },
        flashRetryCount: { type: Number, default: 3 },
        useDeviceArgument: { type: Boolean, default: true },
        probeCommand: { type: [String], default: [] },
        flashCommand: { type: [String], default: [] },
        resetCommand: { type: [String], default: [] },
    },
    { _id: false }
);

const vcomSchema = new Schema(
    {
        mode: { type: String, default: "ip" },
        tcpPort: { type: Number, default: 4901 },
        baudRate: { type: Number, default: 115200 },
        captureTimeoutSeconds: { type: Number, default: 30 },
        startupDelaySeconds: { type: Number, default: 0.25 },
        serialReadTimeoutSeconds: { type: Number, default: 0.25 },
    },
    { _id: false }
);

const pathsSchema = new Schema(
    {
        workspaceRoot: { type: String, default: "" },
        downloadsDir: { type: String, default: "downloads" },
        sdksDir: { type: String, default: "sdks" },
        binariesDir: { type: String, default: "binaries" },
        logsDir: { type: String, default: "logs" },
        reportsDir: { type: String, default: "reports" },
    },
    { _id: false }
);

const discoverySchema = new Schema(
    {
        defaultRootFolder: { type: String, default: "" },
        binaryExtension: { type: String, default: ".s37" },
        boardNamePattern: { type: String, default: "brd[0-9]+[a-z]+" },
    },
    { _id: false }
);

const buildAdapterSchema = new Schema(
    {
        enabled: { type: Boolean, default: true },
        slcPath: { type: String, default: "" },
        cmakePath: { type: String, default: "" },
        ninjaPath: { type: String, default: "" },
        /** Sets ARM_GCC_DIR for CMake/GCC builds */
        gccPath: { type: String, default: "" },
        /**
         * Path templates. Placeholders: {build}, {board}
         * Defaults match the reference PowerShell scripts.
         */
        sdkRootTemplate: {
            type: String,
            default: "C:\\{build}\\gecko-sdk",
        },
        aimlRelative: {
            type: String,
            default: "extension\\aiml-extension",
        },
        wiseconnectRelative: {
            type: String,
            default: "extension\\wiseconnect",
        },
        examplesRelative: {
            type: String,
            default: "extension\\aiml-extension\\examples",
        },
        generateRootTemplate: {
            type: String,
            default: "C:\\slc-test\\generated\\{build}\\{board}",
        },
        /** Max parallel build units (board×project×toolchain) */
        concurrency: { type: Number, default: 2 },
        generateTimeoutSeconds: { type: Number, default: 600 },
        buildTimeoutSeconds: { type: Number, default: 1800 },
        makePath: { type: String, default: "" },
        generateCommand: { type: [String], default: [] },
        buildCommand: { type: [String], default: [] },
        notes: { type: String, default: "" },
    },
    { _id: false }
);

const sdkPrepareSchema = new Schema(
    {
        enabled: { type: Boolean, default: true },
        /** Default extensions when request omits extensions[] */
        defaultExtensions: {
            type: [String],
            default: () => ["aiml-extension", "wiseconnect"],
        },
        geckoZipName: { type: String, default: "gecko-sdk.zip" },
        /**
         * Relative folder under the Artifactory build URL for extension zips.
         * Empty = same folder as gecko-sdk.zip. Also tries "extensions" and "extension".
         */
        extensionsSubdir: { type: String, default: "" },
        /** C:\{build}\gecko-sdk */
        sdkRootTemplate: {
            type: String,
            default: "C:\\{build}\\gecko-sdk",
        },
        /**
         * Max parallel ZIP downloads (gecko + extensions).
         * Extract stays sequential to avoid disk thrashing.
         */
        downloadConcurrency: { type: Number, default: 4 },
        notes: { type: String, default: "" },
    },
    { _id: false }
);

const systemSchema = new Schema(
    {
        key: { type: String, default: "system", unique: true },
        flashTool: { type: flashToolSchema, default: () => ({}) },
        toolchains: { type: [String], default: [] },
        vcom: { type: vcomSchema, default: () => ({}) },
        paths: { type: pathsSchema, default: () => ({}) },
        discovery: { type: discoverySchema, default: () => ({}) },
        buildAdapter: { type: buildAdapterSchema, default: () => ({}) },
        sdkPrepare: { type: sdkPrepareSchema, default: () => ({}) },
    },
    { timestamps: true }
);

const System = model("System", systemSchema);

export default System;

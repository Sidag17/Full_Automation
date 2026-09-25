import { Schema, model } from "mongoose";

const boardSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    ip: {
      type: String,
      default: "",
      trim: true,
    },
    serialno: {
      type: String,
      default: "",
      trim: true,
    },
    chipType: {
      type: String,
      default: "",
      trim: true,
    },
    /** efr32 | siwg917 | … — used in application folder templates {family} */
    family: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    vcomPort: {
      type: String,
      default: "",
      trim: true,
    },
    vcomMode: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    baudRate: {
      type: Number,
      default: 115200,
    },
    enabled: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

const Board = model("Board", boardSchema);
export default Board;
import mongoose from "mongoose";

export default async function connectDB(mongoUri) {
    if (!mongoUri) {
        throw new Error("MONGODB_URI is not set");
    }

    await mongoose.connect(mongoUri);
}

export function getMongoStatus(){
    return mongoose.connection.readyState;
}

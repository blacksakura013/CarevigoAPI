const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI not found");
    }

    mongoose.set("strictQuery", true);

    const conn = await mongoose.connect(process.env.MONGO_URI, {
      dbName: "carevigo_db",

      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });

    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

    return conn;

  } catch (err) {
    // Let startup fail before opening the HTTP port. The caller owns reporting
    // and must not expose a connection error that can contain credentials.
    throw err;
  }
};

module.exports = connectDB;

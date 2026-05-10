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
    console.error("❌ MongoDB Error:", err.message);

    // ❌ ห้าม process.exit(1)
    return null;
  }
};

module.exports = connectDB;
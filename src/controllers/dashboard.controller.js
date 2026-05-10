// src/controllers/dashboard.controller.js

const os = require("os");

const User = require("../models/User");
const Health = require("../models/Health");

const response = require("../utils/response");

// ===============================
// SUMMARY
// ===============================
exports.summary = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      verifiedUsers,
      pendingUsers,
      totalHealthRecords,
      todayHealthRecords,
      todayNewUsers,
      highRiskUsers
    ] = await Promise.all([
      User.countDocuments(),

      User.countDocuments({
        isVerified: true
      }),

      User.countDocuments({
        status: "pending"
      }),

      Health.countDocuments(),

      Health.countDocuments({
        createdAt: { $gte: today }
      }),

      User.countDocuments({
        createdAt: { $gte: today }
      }),

      Health.countDocuments({
        "cvdRisk.level": "risk_high"
      })
    ]);

    return response.success({
      res,
      message: "Dashboard summary fetched",
      data: {
        totalUsers,
        verifiedUsers,
        pendingUsers,
        totalHealthRecords,
        todayHealthRecords,
        todayNewUsers,
        highRiskUsers
      }
    });

  } catch (err) {
    return response.error({
      res,
      message: err.message
    });
  }
};

// ===============================
// USER ANALYTICS
// ===============================
exports.usersAnalytics = async (req, res) => {
  try {
    const users = await User.aggregate([
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt"
            }
          },
          users: { $sum: 1 }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);

    return response.success({
      res,
      message: "User analytics fetched",
      data: users
    });

  } catch (err) {
    return response.error({
      res,
      message: err.message
    });
  }
};

// ===============================
// HEALTH ANALYTICS
// ===============================
exports.healthAnalytics = async (req, res) => {
  try {

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const skip = (page - 1) * limit;

    const type = req.query.type;

    // ===============================
    // FILTER
    // ===============================
    const filter = {};

    if (type) {
      filter.type = type;
    }

    // ===============================
    // SUMMARY
    // ===============================
    const grouped = await Health.aggregate([
      {
        $group: {
          _id: "$type",
          total: { $sum: 1 }
        }
      }
    ]);

    const summary = {
      blood_pressure: 0,
      sugar: 0,
      cholesterol: 0
    };

    grouped.forEach(item => {
      summary[item._id] = item.total;
    });

    // ===============================
    // RECORDS
    // ===============================
    const records = await Health.find(filter)

      .populate({
        path: "userId",
        select: `
          firstName
          lastName
          phone
          province
          gender
          birthDate
          citizenId
        `
      })

      .sort({ createdAt: -1 })

      .skip(skip)

      .limit(limit);

    // ===============================
    // FORMAT
    // ===============================
    const formatted = records.map(item => ({
      _id: item._id,

      type: item.type,

      value: item.value,

      bmi: item.bmi,

      cvdRisk: item.cvdRisk,

      createdAt: item.createdAt,

      user: item.userId
    }));

    // ===============================
    // TOTAL
    // ===============================
    const total = await Health.countDocuments(filter);

    return response.success({
      res,
      message: "Health analytics fetched",

      total,

      page,

      limit,

      hasMore: skip + records.length < total,

      data: {
        summary,
        records: formatted
      }
    });

  } catch (err) {

    return response.error({
      res,
      message: err.message
    });

  }
};
// ===============================
// RISK ANALYTICS
// ===============================
exports.riskAnalytics = async (req, res) => {
  try {

    const grouped = await Health.aggregate([
      {
        $match: {
          cvdRisk: { $ne: null }
        }
      },
      {
        $group: {
          _id: "$cvdRisk.level",
          total: { $sum: 1 }
        }
      }
    ]);

    const result = {
      normal: 0,
      risk_low: 0,
      risk_medium: 0,
      risk_high: 0
    };

    grouped.forEach(item => {
      result[item._id] = item.total;
    });

    return response.success({
      res,
      message: "Risk analytics fetched",
      data: result
    });

  } catch (err) {
    return response.error({
      res,
      message: err.message
    });
  }
};

// ===============================
// VERIFICATION ANALYTICS
// ===============================
exports.verificationAnalytics = async (req, res) => {
  try {

    const [
      verified,
      pending,
      rejected
    ] = await Promise.all([
      User.countDocuments({
        isVerified: true
      }),

      User.countDocuments({
        status: "pending"
      }),

      User.countDocuments({
        status: "rejected"
      })
    ]);

    return response.success({
      res,
      message: "Verification analytics fetched",
      data: {
        verified,
        pending,
        rejected
      }
    });

  } catch (err) {
    return response.error({
      res,
      message: err.message
    });
  }
};

// ===============================
// SYSTEM ANALYTICS
// ===============================
exports.systemAnalytics = async (req, res) => {
  try {

    const memoryUsage = process.memoryUsage();

    return response.success({
      res,
      message: "System analytics fetched",
      data: {
        uptime: process.uptime(),

        nodeVersion: process.version,

        platform: process.platform,

        cpuCores: os.cpus().length,

        totalMemory:
          Math.round(os.totalmem() / 1024 / 1024) + " MB",

        freeMemory:
          Math.round(os.freemem() / 1024 / 1024) + " MB",

        heapUsed:
          Math.round(memoryUsage.heapUsed / 1024 / 1024) + " MB",

        heapTotal:
          Math.round(memoryUsage.heapTotal / 1024 / 1024) + " MB"
      }
    });

  } catch (err) {
    return response.error({
      res,
      message: err.message
    });
  }
};

// ===============================
// TOP PROVINCES RISK
// ===============================
exports.riskByProvince = async (req, res) => {
  try {

    const result = await User.aggregate([
      {
        $lookup: {
          from: "healths",
          localField: "_id",
          foreignField: "userId",
          as: "health"
        }
      },

      {
        $unwind: "$health"
      },

      {
        $match: {
          "health.cvdRisk.level": "risk_high"
        }
      },

      {
        $group: {
          _id: "$province",
          total: { $sum: 1 }
        }
      },

      {
        $sort: {
          total: -1
        }
      },

      {
        $limit: 10
      }
    ]);

    return response.success({
      res,
      message: "Risk by province fetched",
      data: result
    });

  } catch (err) {
    return response.error({
      res,
      message: err.message
    });
  }
};

// ===============================
// TOP CHRONIC DISEASES
// ===============================
exports.topChronicDiseases = async (req, res) => {
  try {

    const result = await User.aggregate([
      {
        $unwind: "$chronicDiseases"
      },

      {
        $group: {
          _id: "$chronicDiseases",
          total: { $sum: 1 }
        }
      },

      {
        $sort: {
          total: -1
        }
      },

      {
        $limit: 10
      }
    ]);

    return response.success({
      res,
      message: "Top chronic diseases fetched",
      data: result
    });

  } catch (err) {
    return response.error({
      res,
      message: err.message
    });
  }
};
// src/controllers/dashboard.controller.js

const os = require("os");

const User = require("../models/User");
const Health = require("../models/Health");

const response = require("../utils/response");
const { dashboardHealthQuery, dashboardHealthPipeline } = require("../utils/dashboardHealthQuery");

// Numeric keys are authoritative. Old ObjectId/citizen links are consulted only
// for rows that have not been backfilled, including during a resumable migration.
const userJoinExpression = { $or: [
  { $and: [{ $gt: ["$$userKey", 0] }, { $eq: ["$internalId", "$$userKey"] }] },
  { $and: [{ $eq: [{ $type: "$$userKey" }, "missing"] }, { $or: [
    { $eq: ["$_id", "$$userId"] }, { $eq: ["$citizenId", "$$citizenId"] }
  ] }] }
] };

// ===============================
// SUMMARY
// ===============================
exports.summary = async (req, res) => {
  try {
    // Reporting follows the Thai calendar day even when the server runs in UTC.
    const bangkokOffset = 7 * 60 * 60 * 1000;
    const bangkokNow = new Date(Date.now() + bangkokOffset);
    const today = new Date(Date.UTC(
      bangkokNow.getUTCFullYear(), bangkokNow.getUTCMonth(), bangkokNow.getUTCDate()
    ) - bangkokOffset);

    const [
      totalUsers,
      verifiedUsers,
      pendingUsers,
      totalHealthRecords,
      todayHealthRecords,
      todayNewUsers,
      highRiskRecords,
      highRiskUserCounts,
      thaiCvRiskGroups
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
      }),

      Health.aggregate([
        { $match: { "cvdRisk.level": "risk_high" } },
        { $lookup: { from: User.collection.name,
          let: { userKey: "$userKey", userId: "$userId", citizenId: "$citizenId" },
          pipeline: [{ $match: { $expr: userJoinExpression } }, { $project: { internalId: 1 } }], as: "linkedUser" } },
        { $group: { _id: { $ifNull: [{ $first: "$linkedUser.internalId" },
          { $ifNull: ["$userKey", { $ifNull: ["$citizenId", "$userId"] }] }] } } },
        { $match: { _id: { $nin: [null, ""] } } },
        { $count: "total" }
      ]),
      User.aggregate([
        { $group: { _id: { status: "$thaiCvRisk.status", level: "$thaiCvRisk.level" }, total: { $sum: 1 } } }
      ])
    ]);
    const thaiCvRisk = { low: 0, moderate: 0, high: 0, incomplete: 0, ineligible: 0, totalCalculated: 0 };
    for (const group of thaiCvRiskGroups) {
      const { status, level } = group._id || {};
      if (status === "calculated" && ["low", "moderate", "high"].includes(level)) {
        thaiCvRisk[level] += group.total;
        thaiCvRisk.totalCalculated += group.total;
      } else if (status === "ineligible") thaiCvRisk.ineligible += group.total;
      else thaiCvRisk.incomplete += group.total;
    }

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
        highRiskUsers: highRiskUserCounts[0]?.total || 0,
        highRiskRecords,
        thaiCvRisk
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
              date: "$createdAt",
              timezone: "Asia/Bangkok"
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
    const query = dashboardHealthQuery(req.query);
    const [grouped, result] = await Promise.all([
      Health.aggregate([{ $group: { _id: "$type", total: { $sum: 1 } } }]),
      Health.aggregate(dashboardHealthPipeline(query, User.collection.name))
        .option({ useBigInt64: true }).collation({ locale: "th", strength: 2 }),
    ]);
    const summary = { blood_pressure: 0, sugar: 0, cholesterol: 0, bmi: 0 };
    grouped.forEach(item => { if (Object.hasOwn(summary, item._id)) summary[item._id] = item.total; });
    const { records = [], total: totals = [] } = result[0] || {};
    return response.success({
      res,
      message: "Health analytics fetched",
      total: totals[0]?.value || 0, page: query.page, limit: query.limit,
      data: { summary, summaryScope: "all", records }
    });
  } catch (err) {
    return response.error({ res, statusCode: err.code === "INVALID_DASHBOARD_QUERY" ? 400 : 500,
      message: err.code === "INVALID_DASHBOARD_QUERY" ? err.message : "โหลดรายการสุขภาพไม่สำเร็จ กรุณาลองอีกครั้ง" });
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
          from: Health.collection.name,
          let: { userKey: "$internalId", userId: "$_id" },
          pipeline: [{ $match: { $expr: { $or: [
            { $and: [{ $gt: ["$$userKey", 0] }, { $eq: ["$userKey", "$$userKey"] }] },
            { $and: [{ $eq: [{ $type: "$userKey" }, "missing"] }, { $eq: ["$userId", "$$userId"] }] }
          ] } } }],
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

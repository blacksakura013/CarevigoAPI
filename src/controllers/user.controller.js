const mongoose = require("mongoose");
const User = require("../models/User");
const Health = require("../models/Health");
const response = require("../utils/response");

// ===============================
// 🟢 CREATE / UPDATE (PUBLIC)
// ===============================
exports.createOrUpdateUser = async (req, res) => {
    try {
        const { citizenId } = req.body;

        if (!citizenId) {
            return response.error({
                res,
                statusCode: 400,
                message: "citizenId is required"
            });
        }

        // 🔒 validate citizenId (13 digits)
        if (!/^\d{13}$/.test(citizenId)) {
            return response.error({
                res,
                statusCode: 400,
                message: "Invalid citizenId format"
            });
        }

        let user = await User.findOne({ citizenId });

        // 🔁 UPDATE
        if (user) {
            user = await User.findOneAndUpdate(
                { citizenId },
                req.body,
                { new: true }
            );

            return response.success({
                res,
                message: "User updated",
                data: {
                    id: user._id,
                    citizenId: user.citizenId,
                    status: user.status,
                    isVerified: user.isVerified
                }
            });
        }

        // ➕ CREATE
        user = await User.create({
            ...req.body,
            status: "pending",
            isVerified: false
        });

        return response.success({
            res,
            message: "User created (pending)",
            data: {
                id: user._id,
                citizenId: user.citizenId,
                status: user.status,
                isVerified: user.isVerified
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
// 🔍 SEARCH BY CITIZEN ID
// ===============================
exports.getUserByCitizenId = async (req, res) => {
    try {
        const { citizenId } = req.query;

        if (!citizenId) {
            return response.error({
                res,
                statusCode: 400,
                message: "citizenId is required"
            });
        }

        const user = await User.findOne({ citizenId });

        if (!user) {
            return response.success({
                res,
                message: "User not found",
                data: null
            });
        }

        return response.success({
            res,
            message: "User found",
            data: user
        });

    } catch (err) {
        return response.error({
            res,
            message: err.message
        });
    }
};

// ===============================
// 🔒 ADMIN CREATE USER
// ===============================
exports.createUserAdmin = async (req, res) => {
    try {
        const { citizenId } = req.body;

        if (!citizenId) {
            return response.error({
                res,
                statusCode: 400,
                message: "citizenId is required"
            });
        }

        const exist = await User.findOne({ citizenId });

        if (exist) {
            return response.error({
                res,
                statusCode: 400,
                message: "User already exists"
            });
        }

        const user = await User.create({
            ...req.body,
            status: "active",
            isVerified: true
        });

        return response.success({
            res,
            message: "User created",
            data: user
        });

    } catch (err) {
        return response.error({
            res,
            message: err.message
        });
    }
};

// ===============================
// ✅ APPROVE USER
// ===============================
exports.approveUser = async (req, res) => {
    try {
        const { id } = req.params;

        const user = await User.findByIdAndUpdate(
            id,
            { status: "active", isVerified: true },
            { new: true }
        );

        if (!user) {
            return response.error({
                res,
                statusCode: 404,
                message: "User not found"
            });
        }

        return response.success({
            res,
            message: "User approved",
            data: user
        });

    } catch (err) {
        return response.error({
            res,
            message: err.message
        });
    }
};

// ===============================
// 📄 GET USERS (PAGINATION)
// ===============================
exports.getUsers = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;

        const skip = (page - 1) * limit;

        const [users, total] = await Promise.all([
            User.find().skip(skip).limit(limit),
            User.countDocuments()
        ]);

        return response.success({
            res,
            message: "Get users success",
            data: users,
            total,
            page,
            limit,
            hasMore: page * limit < total
        });

    } catch (err) {
        return response.error({
            res,
            message: err.message
        });
    }
};

// ===============================
// 👤 GET USER BY ID
// ===============================
exports.getUserById = async (req, res) => {
    try {
        const requester = req.user;

        if (
            requester.role !== "admin" &&
            requester.id.toString() !== req.params.id.toString()
        ) {
            return response.error({
                res,
                statusCode: 403,
                message: "Forbidden"
            });
        }

        const user = await User.findById(req.params.id);

        if (!user) {
            return response.error({
                res,
                statusCode: 404,
                message: "User not found"
            });
        }

        return response.success({
            res,
            message: "User found",
            data: user
        });

    } catch (err) {
        return response.error({
            res,
            message: err.message
        });
    }
};

// ===============================
// 📊 FULL PROFILE + HEALTH
// ===============================
exports.getUserFullProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const requester = req.user;

    if (
      requester.role !== "admin" &&
      requester.id.toString() !== id.toString()
    ) {
      return response.error({
        res,
        statusCode: 403,
        message: "Forbidden"
      });
    }

    const user = await User.findById(id);

    if (!user) {
      return response.error({
        res,
        statusCode: 404,
        message: "User not found"
      });
    }

    const health = await Health.find({
      $or: [
        { userId: user._id },
        { citizenId: String(user.citizenId) }
      ]
    }).sort({ createdAt: -1 });

    // 🔥 GROUP BY TYPE
    const grouped = {
      blood_pressure: [],
      sugar: [],
      cholesterol: []
    };

    health.forEach((item) => {
      if (!grouped[item.type]) {
        grouped[item.type] = [];
      }
      grouped[item.type].push(item);
    });

    return response.success({
      res,
      message: "User profile fetched",
      data: {
        user,
        health: grouped
      }
    });

  } catch (err) {
    return response.error({
      res,
      message: err.message
    });
  }
};
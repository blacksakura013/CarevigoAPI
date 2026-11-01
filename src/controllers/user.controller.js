const User = require("../models/User");
const Health = require("../models/Health");
const response = require("../utils/response");
const { getPagination } = require("../utils/pagination");
const { pickProfile, safePatient } = require("../utils/patientProfile");
const { calculateThaiCvRisk } = require("../utils/thaiCvRisk");
const { healthForUser } = require("../utils/internalQueries");
const { validateAgreements, agreementProof, sendAgreementError } = require("../utils/legal");

// ===============================
// 🟢 CREATE / UPDATE (PUBLIC)
// ===============================
// Compatibility export; HTTP routes require staff and creation never updates an
// existing account or accepts account/security fields from a registration body.
exports.createOrUpdateUser = (req, res) => exports.createUserAdmin(req, res);

// ===============================
// 🔍 SEARCH BY CITIZEN ID
// ===============================
exports.getUserByCitizenId = async (req, res) => {
    try {
        const { citizenId } = req.query;

        if (typeof citizenId !== "string" || !/^\d{13}$/.test(citizenId)) {
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
            data: safePatient(user)
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
        const { citizenId } = req.body || {};
        const legalAgreement = agreementProof(validateAgreements(req.body?.agreements, "staff-attestation"), "staff-attestation", req.user);

        if (typeof citizenId !== "string" || !/^\d{13}$/.test(citizenId)) {
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

        if (typeof citizenId !== "string" || !/^\d{13}$/.test(citizenId)) {
            return response.error({ res, statusCode: 400, message: "เลขบัตรประชาชนต้องมี 13 หลัก" });
        }
        const profile = pickProfile(req.body);
        const user = await User.create({
            ...profile,
            legalAgreement,
            legalAgreementHistory: [legalAgreement],
            citizenId,
            status: "active",
            isVerified: true,
            thaiCvRisk: calculateThaiCvRisk(profile)
        });

        return response.success({
            res,
            message: "User created",
            data: safePatient(user)
        });

    } catch (err) {
        if (sendAgreementError(err, res)) return;
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
            data: safePatient(user)
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
        const { page, limit, skip } = getPagination(req.query);
        const { status, search, riskLevel } = req.query;
        if (
            (status !== undefined && typeof status !== "string") ||
            (search !== undefined && typeof search !== "string") ||
            (riskLevel !== undefined && !["low", "moderate", "high", "unavailable"].includes(riskLevel))
        ) {
            return response.error({
                res,
                statusCode: 400,
                message: "Invalid member filters"
            });
        }

        const filter = {};
        if (status && status.trim()) filter.status = status.trim();
        if (riskLevel === "unavailable") filter["thaiCvRisk.status"] = { $ne: "calculated" };
        else if (riskLevel) {
            filter["thaiCvRisk.status"] = "calculated";
            filter["thaiCvRisk.level"] = riskLevel;
        }
        if (search && search.trim()) {
            const escapedSearch = search.trim().slice(0, 100)
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            filter.$or = [
                ...["firstName", "lastName", "citizenId", "phone", "province"].map(
                    field => ({ [field]: { $regex: escapedSearch, $options: "i" } })
                ),
                {
                    $expr: {
                        $regexMatch: {
                            input: {
                                $concat: [
                                    { $ifNull: ["$firstName", ""] },
                                    " ",
                                    { $ifNull: ["$lastName", ""] }
                                ]
                            },
                            regex: escapedSearch,
                            options: "i"
                        }
                    }
                }
            ];
        }

        const [users, total] = await Promise.all([
            User.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
            User.countDocuments(filter)
        ]);

        return response.success({
            res,
            message: "Get users success",
            data: users.map(safePatient),
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
            !["admin", "superadmin"].includes(requester.role) &&
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
            data: safePatient(user)
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
      !["admin", "superadmin"].includes(requester.role) &&
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

    const health = await Health.find(healthForUser(user)).sort({ createdAt: -1 });

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
        user: safePatient(user),
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

// src/routes/line.routes.js
const router = require("express").Router();
const { line, config } = require("../config/line");
const controller = require("../controllers/line.controller");

router.post("/webhook", line.middleware(config), controller.handleWebhook);

module.exports = router;
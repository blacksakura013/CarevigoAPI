const axios = require("axios");

const API = axios.create({
  baseURL: process.env.API_BASE_URL,
  timeout: 20000,
});

exports.getProfile = (citizenId) =>
  API.get(`/public/profile/${citizenId}`);
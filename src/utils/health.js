exports.calculateBMI = (weight, heightCm) => {
  const h = heightCm / 100;
  return Number((weight / (h * h)).toFixed(2));
};

exports.calculateCVDRisk = (bmi) => {
  if (bmi < 18.5) {
    return { level: "underweight", label: "มากกว่าปกติ (เสี่ยงขาดสารอาหาร)" };
  } else if (bmi < 23) {
    return { level: "normal", label: "เท่ากับคนปกติ" };
  } else if (bmi < 25) {
    return { level: "risk_low", label: "เพิ่มขึ้นเล็กน้อย" };
  } else if (bmi < 30) {
    return { level: "risk_medium", label: "เพิ่มขึ้น" };
  } else {
    return { level: "risk_high", label: "เสี่ยงสูงมาก" };
  }
};
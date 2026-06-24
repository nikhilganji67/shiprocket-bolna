require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const processed = new Set();
let shiprocketToken = null;
let tokenExpiry = null;

const STATUS = {
  UNDELIVERED_A1: 9,
  UNDELIVERED_A2: 14,
  RTO_INITIATED: 17,
};

const BOLNA_AGENTS = {
  DELAY: process.env.BOLNA_AGENT_DELAY,
  ATTEMPT_1: process.env.BOLNA_AGENT_ATTEMPT_1,
  ATTEMPT_2: process.env.BOLNA_AGENT_ATTEMPT_2,
};

// ── Forward to existing webhook ───────────────────────────────────
async function forwardWebhook(payload) {
  try {
    await axios.post(
      process.env.FORWARD_WEBHOOK_URL,
      payload,
      {
        headers: {
          "x-api-key": process.env.FORWARD_WEBHOOK_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`[FORWARD] Payload forwarded to existing webhook`);
  } catch (e) {
    console.error(`[FORWARD] Failed:`, e.response?.data || e.message);
  }
}

// ── Shiprocket Auth ───────────────────────────────────────────────
async function getShiprocketToken() {
  if (shiprocketToken && tokenExpiry && Date.now() < tokenExpiry) {
    return shiprocketToken;
  }
  const res = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", {
    email: process.env.SHIPROCKET_EMAIL,
    password: process.env.SHIPROCKET_PASSWORD,
  });
  shiprocketToken = res.data.token;
  tokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000;
  console.log("[SHIPROCKET] Token refreshed");
  return shiprocketToken;
}

// ── Fetch customer details ────────────────────────────────────────
async function getCustomerDetails(orderId) {
  try {
    const token = await getShiprocketToken();
    const res = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/orders/show/${orderId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const order = res.data.data;
    return {
      customer_name: order?.billing_customer_name || order?.customer_name || "Customer",
      customer_phone: order?.billing_phone || order?.customer_phone || null,
    };
  } catch (e) {
    console.error(`[SHIPROCKET] Failed to fetch order ${orderId}:`, e.response?.data || e.message);
    return { customer_name: "Customer", customer_phone: null };
  }
}

// ── Trigger Bolna Call ────────────────────────────────────────────
async function triggerBolnaCall(agentId, recipientPhone, userData) {
  if (!agentId) return console.warn(`[BOLNA] Agent ID missing`);
  const response = await axios.post(
    "https://api.bolna.ai/call",
    {
      agent_id: agentId,
      recipient_phone_number: recipientPhone,
      from_phone_number: process.env.BOLNA_FROM_NUMBER,
      user_data: userData,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.BOLNA_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  console.log(`[BOLNA] Call triggered → agent=${agentId} call_id=${response.data?.call_id}`);
}

// ── Helpers ───────────────────────────────────────────────────────
function isDelayed(etd, thresholdHours = 24) {
  if (!etd) return false;
  return (Date.now() - new Date(etd).getTime()) / 3600000 >= thresholdHours;
}

function getAttemptCount(scans = []) {
  return scans.filter((s) => {
    const activity = (s.activity || "").toLowerCase();
    return (
      activity.includes("undelivered") ||
      activity.includes("delivery attempt failed") ||
      activity.includes("unable to deliver")
    );
  }).length;
}

// ── Webhook ───────────────────────────────────────────────────────
app.post("/webhook/shiprocket", async (req, res) => {
  const incomingToken = req.headers["x-api-key"];
  if (incomingToken !== process.env.SHIPROCKET_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Respond immediately
  res.status(200).json({ received: true });

  // Forward to existing webhook first — fire and forget
  forwardWebhook(req.body);

  const {
    awb,
    order_id,
    current_status,
    current_status_id,
    courier_name,
    etd,
    scans = [],
  } = req.body;

  console.log(`[WEBHOOK] AWB=${awb} order=${order_id} status=${current_status} (id=${current_status_id})`);

  // Fetch customer details from Shiprocket
  const { customer_name, customer_phone } = await getCustomerDetails(order_id);
  if (!customer_phone) {
    return console.error(`[ERROR] No phone found for order ${order_id}`);
  }

  console.log(`[CUSTOMER] ${customer_name} — ${customer_phone}`);

  // Idempotency check
  const attemptCount = getAttemptCount(scans);
  const eventKey = `${awb}:${current_status_id}:${attemptCount}`;
  if (processed.has(eventKey)) return console.log(`[SKIP] Duplicate ${eventKey}`);
  processed.add(eventKey);

  const baseUserData = {
    customer_name,
    order_id,
    awb,
    courier_name: courier_name || "our courier partner",
    new_etd: etd ? new Date(etd).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "soon",
    brand_name: "GoodFlip",
  };

  // ── Trigger: DELAY ──
  if (isDelayed(etd, 24)) {
    console.log(`[TRIGGER] DELAY — AWB ${awb}`);
    return await triggerBolnaCall(BOLNA_AGENTS.DELAY, customer_phone, baseUserData);
  }

  // ── Trigger: ATTEMPT 1 ──
  if (current_status_id === STATUS.UNDELIVERED_A1 || attemptCount === 1) {
    console.log(`[TRIGGER] ATTEMPT 1 FAILED — AWB ${awb}`);
    return setTimeout(async () => {
      await triggerBolnaCall(BOLNA_AGENTS.ATTEMPT_1, customer_phone, baseUserData);
    }, parseInt(process.env.A1_CALL_DELAY_MS || "7200000"));
  }

  // ── Trigger: ATTEMPT 2 ──
  if (current_status_id === STATUS.UNDELIVERED_A2 || attemptCount >= 2) {
    console.log(`[TRIGGER] ATTEMPT 2 FAILED — AWB ${awb}`);
    return setTimeout(async () => {
      await triggerBolnaCall(BOLNA_AGENTS.ATTEMPT_2, customer_phone, baseUserData);
    }, parseInt(process.env.A2_CALL_DELAY_MS || "3600000"));
  }

  console.log(`[SKIP] No trigger matched for status_id=${current_status_id}`);
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));

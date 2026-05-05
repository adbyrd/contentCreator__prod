/**
 * HMAC Validation
 * @version 1.2.0
 **/

const crypto = require("crypto");

const body    = $input.item.json.body    ?? $input.item.json;
const headers = $input.item.json.headers ?? {};

if (!body || typeof body !== "object") {
  const ts = new Date().toISOString();
  console.error("[ WEBHOOK TRIGGER : v1.2.0 ] MALFORMED_PAYLOAD | body could not be extracted | " + ts);
  throw new Error(JSON.stringify({
    ok: false, status: 400,
    error: { type: "MALFORMED_PAYLOAD", message: "Request body is missing or could not be parsed." },
    meta: { component: "WEBHOOK TRIGGER", version: "v1.2.0", timestamp: ts }
  }));
}

const receivedSig = headers["x-hmac-signature"] ?? headers["X-HMAC-Signature"] ?? "";

if (!receivedSig) {
  const ts = new Date().toISOString();
  console.error("[ WEBHOOK TRIGGER : v1.2.0 ] UNAUTHORIZED | missing X-HMAC-Signature | " + ts);
  throw new Error(JSON.stringify({
    ok: false, status: 401,
    error: { type: "UNAUTHORIZED", message: "HMAC signature header missing." },
    meta: { component: "WEBHOOK TRIGGER", version: "v1.2.0", timestamp: ts }
  }));
}

const secret = $vars.N8N_CALLBACK_SECRET_KEY;

if (!secret) {
  const ts = new Date().toISOString();
  console.error("[ WEBHOOK TRIGGER : v1.2.0 ] CONFIG_ERROR | N8N_CALLBACK_SECRET_KEY not set | " + ts);
  throw new Error(JSON.stringify({
    ok: false, status: 500,
    error: { type: "CONFIG_ERROR", message: "Pipeline secret is not configured." },
    meta: { component: "WEBHOOK TRIGGER", version: "v1.2.0", timestamp: ts }
  }));
}


const rawBody     = JSON.stringify(body);
const expectedSig = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
const buf1        = Buffer.from(receivedSig, "hex");
const buf2        = Buffer.from(expectedSig, "hex");
const sigValid    = buf1.length === buf2.length && crypto.timingSafeEqual(buf1, buf2);

if (!sigValid) {
  const ts = new Date().toISOString();
  console.error("[ WEBHOOK TRIGGER : v1.2.0 ] INVALID_SIGNATURE | SECURITY EVENT | timestamp: " + ts + " | DO NOT LOG PAYLOAD");
  throw new Error(JSON.stringify({
    ok: false, status: 403,
    error: { type: "INVALID_SIGNATURE", message: "HMAC signature validation failed." },
    meta: { component: "WEBHOOK TRIGGER", version: "v1.2.0", timestamp: ts }
  }));
}

const REQUIRED = [
  "projectId",
  "owner",
  "companyName",
  "companyDescription",
  "primaryCategory",
  "customerType",
  "title",
  "goal",
  "offer",
  "misconception",
  "targetAudience"
];

const missing = REQUIRED.filter(function(f) { return !body[f] && body[f] !== 0; });

if (missing.length > 0) {
  const masked = body.owner ? body.owner.substring(0, 6) + "****" : "UNKNOWN";
  console.error(
    "[ WEBHOOK TRIGGER : v1.2.0 ] PAYLOAD_INVALID" +
    " | projectId: "     + (body.projectId ?? "UNKNOWN") +
    " | owner: "         + masked +
    " | missingFields: [" + missing.join(", ") + "]"
  );
  throw new Error(JSON.stringify({
    ok: false, status: 400,
    error: { type: "INVALID_PAYLOAD", message: "Missing required fields: " + missing.join(", ") },
    meta: { component: "WEBHOOK TRIGGER", version: "v1.2.0", missingFields: missing }
  }));
}

const requestId   = "req_" + body.projectId + "_" + Date.now();
const maskedOwner = body.owner.substring(0, 6) + "****";

console.log("[ WEBHOOK TRIGGER : v1.2.0 ] HMAC_VALIDATED | requestId: "   + requestId + " | projectId: " + body.projectId + " | owner: " + maskedOwner + " | timestamp: " + new Date().toISOString());
console.log("[ WEBHOOK TRIGGER : v1.2.0 ] PAYLOAD_VALID | requestId: "    + requestId + " | projectId: " + body.projectId + " | allFields: confirmed");
console.log("[ WEBHOOK TRIGGER : v1.2.0 ] HANDOFF_SUCCESS | requestId: "  + requestId + " | projectId: " + body.projectId + " | nextStage: prompt-generation");

return [{
  json: {
    projectId:          body.projectId,
    owner:              body.owner,
    companyName:        body.companyName,
    companyDescription: body.companyDescription,
    primaryCategory:    body.primaryCategory,
    customerType:       body.customerType,
    title:              body.title,
    goal:               body.goal,
    offer:              body.offer,
    misconception:      body.misconception,
    targetAudience:     body.targetAudience,
    submissionId:       body.submissionId ?? requestId,
    requestId:          requestId,
    pipelineVersion:    "v1.2.0",
    stage1CompletedAt:  new Date().toISOString()
  }
}];
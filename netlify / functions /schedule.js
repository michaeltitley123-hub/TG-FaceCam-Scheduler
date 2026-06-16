const https = require("https");
const fs = require("fs");
const STORE_PATH = "/tmp/tg_schedule_store.json";

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch (e) {}
  return { jobs: [] };
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store), "utf8");
}

function telegramRequest(botToken, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${botToken}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false }); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const path = event.path.replace(/\/.netlify\/functions\/schedule\/?/, "") || "/";
  const method = event.httpMethod;

  // POST / — schedule a new job using a Telegram file_id
  if (method === "POST" && (path === "/" || path === "")) {
    const body = JSON.parse(event.body || "{}");
    const { botToken, channelId, fileId, scheduledAt } = body;

    if (!botToken || !channelId || !fileId || !scheduledAt) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Missing fields" }) };
    }

    const store = loadStore();
    const job = {
      id: Date.now().toString(),
      botToken, channelId, fileId, scheduledAt,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    store.jobs.push(job);
    saveStore(store);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, jobId: job.id, scheduledAt }) };
  }

  // GET /jobs
  if (method === "GET" && path === "jobs") {
    const store = loadStore();
    const safe = store.jobs.map((j) => ({
      id: j.id, channelId: j.channelId, scheduledAt: j.scheduledAt,
      status: j.status, createdAt: j.createdAt, result: j.result,
    }));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, jobs: safe }) };
  }

  // DELETE /job/:id
  if (method === "DELETE" && path.startsWith("job/")) {
    const jobId = path.replace("job/", "");
    const store = loadStore();
    const idx = store.jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: "Not found" }) };
    if (store.jobs[idx].status === "pending") { store.jobs[idx].status = "cancelled"; saveStore(store); }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // POST /run — called by cron every minute, fires due jobs
  if (method === "POST" && path === "run") {
    const store = loadStore();
    const now = Date.now();
    const pending = store.jobs.filter((j) => j.status === "pending" && new Date(j.scheduledAt).getTime() <= now);

    for (const job of pending) {
      try {
        const res = await telegramRequest(job.botToken, "sendVideoNote", {
          chat_id: job.channelId,
          video_note: job.fileId,
        });
        job.status = res.ok ? "sent" : "failed";
        job.result = res.ok ? "Success" : res.description;
      } catch (e) {
        job.status = "failed";
        job.result = e.message;
      }
    }

    saveStore(store);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, processed: pending.length }) };
  }

  return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: "Not found" }) };
};

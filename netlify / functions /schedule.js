const https = require("https");
const http = require("http");
const { URL } = require("url");

// In-memory store (persists as long as the function container is warm)
// For true persistence we use a simple file via /tmp
const fs = require("fs");
const STORE_PATH = "/tmp/tg_schedule_store.json";

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    }
  } catch (e) {}
  return { jobs: [] };
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store), "utf8");
}

async function sendVideoNote(botToken, chatId, fileUrl) {
  return new Promise((resolve, reject) => {
    // First download the file
    const proto = fileUrl.startsWith("https") ? https : http;
    proto.get(fileUrl, (fileRes) => {
      const chunks = [];
      fileRes.on("data", (chunk) => chunks.push(chunk));
      fileRes.on("end", () => {
        const fileBuffer = Buffer.concat(chunks);
        const boundary = "----FormBoundary" + Date.now();
        const filename = "video_note.mp4";

        let bodyParts = [];
        // chat_id field
        bodyParts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`
          )
        );
        // video_note file field
        bodyParts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="video_note"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`
          )
        );
        bodyParts.push(fileBuffer);
        bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

        const body = Buffer.concat(bodyParts);

        const options = {
          hostname: "api.telegram.org",
          path: `/bot${botToken}/sendVideoNote`,
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
          },
        };

        const req = https.request(options, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              resolve({ ok: false, description: "Parse error" });
            }
          });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      fileRes.on("error", reject);
    });
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const path = event.path.replace("/.netlify/functions/schedule", "") || "/";
  const method = event.httpMethod;

  // POST /schedule — add a new scheduled job
  if (method === "POST" && path === "/") {
    const body = JSON.parse(event.body || "{}");
    const { botToken, channelId, fileUrl, scheduledAt } = body;

    if (!botToken || !channelId || !fileUrl || !scheduledAt) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: "Missing fields" }),
      };
    }

    const store = loadStore();
    const job = {
      id: Date.now().toString(),
      botToken,
      channelId,
      fileUrl,
      scheduledAt,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    store.jobs.push(job);
    saveStore(store);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, jobId: job.id, scheduledAt }),
    };
  }

  // GET /jobs — list jobs
  if (method === "GET" && path === "/jobs") {
    const store = loadStore();
    // Return jobs without exposing bot tokens
    const safe = store.jobs.map((j) => ({
      id: j.id,
      channelId: j.channelId,
      scheduledAt: j.scheduledAt,
      status: j.status,
      createdAt: j.createdAt,
      result: j.result,
    }));
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, jobs: safe }),
    };
  }

  // DELETE /job/:id — cancel a job
  if (method === "DELETE" && path.startsWith("/job/")) {
    const jobId = path.replace("/job/", "");
    const store = loadStore();
    const idx = store.jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ ok: false, error: "Job not found" }),
      };
    }
    if (store.jobs[idx].status === "pending") {
      store.jobs[idx].status = "cancelled";
      saveStore(store);
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true }),
    };
  }

  // POST /run — triggered by Netlify scheduled function, processes due jobs
  if (method === "POST" && path === "/run") {
    const store = loadStore();
    const now = Date.now();
    const pending = store.jobs.filter(
      (j) => j.status === "pending" && new Date(j.scheduledAt).getTime() <= now
    );

    const results = [];
    for (const job of pending) {
      try {
        const res = await sendVideoNote(job.botToken, job.channelId, job.fileUrl);
        job.status = res.ok ? "sent" : "failed";
        job.result = res.ok ? "Success" : res.description;
      } catch (e) {
        job.status = "failed";
        job.result = e.message;
      }
      results.push({ id: job.id, status: job.status });
    }

    saveStore(store);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, processed: results.length, results }),
    };
  }

  return {
    statusCode: 404,
    headers,
    body: JSON.stringify({ ok: false, error: "Not found" }),

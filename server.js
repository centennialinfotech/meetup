import dotenv from "dotenv";
dotenv.config();

import express from "express";
import sql from "mssql";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // serve frontend

// ✅ DB config
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  port: 1433,
  options: {
    encrypt: true,
    trustServerCertificate: true
  }
};

let pool;

// ✅ connect DB
async function connectDB() {
  pool = await sql.connect(dbConfig);
  console.log("✅ DB Connected");
}

// ✅ SEARCH API
app.get("/search", async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).send("DB not ready");
    }

    const search = req.query.q;

    if (!search) return res.json([]);

    const request = pool.request();

    request.input("search", sql.NVarChar(4000), `%${search}%`);

    const query = `
      SELECT TOP 50 *
      FROM event
      WHERE event_title LIKE @search
         OR eventbriteID LIKE @search
      ORDER BY edate DESC
    `;

    const result = await request.query(query);
    res.json(result.recordset);

  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// ✅ health route
app.get("/", (req, res) => {
  res.send("🚀 Event Search API is running");
});

// ✅ START SERVER (IMPORTANT)
async function startServer() {
  try {
    await connectDB();

    const PORT = process.env.PORT || 3000;

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (err) {
    console.error("❌ Startup failed:", err);
  }
}

startServer();
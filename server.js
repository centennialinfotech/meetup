import dotenv from "dotenv";
dotenv.config();
import express from "express";
import sql from "mssql";
import cors from "cors";
import path from "path";
const app = express();
// serve static files
app.use(express.static("public"));
app.use(cors());
app.use(express.json());

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

// connect once
async function connectDB() {
  pool = await sql.connect(dbConfig);
  console.log("✅ DB Connected");
}

connectDB();


// 🔍 SEARCH API
app.get("/search", async (req, res) => {
  try {
    const search = req.query.q;

    if (!search) {
      return res.json([]);
    }

    let request = pool.request();
    let query = "";

    if (search.startsWith("evt-")) {
      // search by ID
      request.input("id", sql.NVarChar(255), search);

      query = `
        SELECT TOP 50 *
        FROM event
        WHERE eventbriteID = @id
        ORDER BY edate DESC
      `;
    } else {
      // search by title
      request.input("title", sql.NVarChar(4000), `%${search}%`);

      query = `
        SELECT TOP 50 *
        FROM event
        WHERE event_title LIKE @title
        ORDER BY edate DESC
      `;
    }
    const result = await request.query(query);
    res.json(result.recordset);
    } catch (err) {
     console.error(err);
     res.status(500).send("Error");
  }
});
app.get("/", (req, res) => {
  res.send("🚀 Event Search API is running");
});

// start server
app.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});
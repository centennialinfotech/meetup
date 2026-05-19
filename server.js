import dotenv from "dotenv";
dotenv.config();

import express from "express";
import sql from "mssql";
import axios from "axios";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));
const TOKEN = process.env.EVENTBRITE_TOKEN;

/* ================= DB CONFIG ================= */
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  port: 1433,
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

let pool;

/* ================= CONNECT DB ================= */
async function connectDB() {
  pool = await sql.connect(dbConfig);
  console.log("✅ DB Connected");
}

/* ================= HELPERS ================= */

// detect ID
function isEventId(input) {
  return /^\d+$/.test(input);
}

// title → slug
function toSlug(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// extract IDs from HTML
function extractEventIds(html) {

  const ids = new Set();

  /* =====================================
     METHOD 1 → tickets URLs
  ===================================== */

  const regex1 =
    /eventbrite\.com\/e\/[^"' ]*-tickets-(\d+)/g;

  let match;

  while ((match = regex1.exec(html)) !== null) {
    ids.add(match[1]);
  }

  /* =====================================
     METHOD 2 → event IDs inside JSON
  ===================================== */

  const regex2 =
    /"event_id":"(\d+)"/g;

  while ((match = regex2.exec(html)) !== null) {
    ids.add(match[1]);
  }

  /* =====================================
     METHOD 3 → numeric IDs
  ===================================== */

  const regex3 =
    /"id":"(\d{6,})"/g;

  while ((match = regex3.exec(html)) !== null) {
    ids.add(match[1]);
  }

  return [...ids];
}

// locations to try
const locations = [
  "online",
  "united-states",
  "ca--san-diego",
  "india",
  "united-kingdom"
];

/* ================= SCRAPE IDS ================= */
async function extractIdsFromSlug(slug) {
  for (const loc of locations) {
    const url = `https://www.eventbrite.com/d/${loc}/${slug}/`;

    try {
      console.log(`🌍 Trying ${url}`);

      const res = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      const ids = extractEventIds(res.data);

      if (ids.length > 0) {
        console.log(`✅ Found ${ids.length} IDs`);
        return ids;
      }

    } catch (err) {
      console.log(`❌ Failed ${loc}`);
    }
  }

  return [];
}

async function extractIdsFromSearch(query) {

  for (const loc of locations) {

    const url =
      `https://www.eventbrite.com/d/${loc}/all-events/?q=${encodeURIComponent(query)}`;

    try {

      console.log("🌍 Trying:", url);

      const res = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      });

      const ids = extractEventIds(res.data);
      console.log("IDS:", ids);

      if (ids.length > 0) {
        return ids;
      }

    } catch (err) {

      console.log("❌ Failed:", loc);
    }
  }

  return [];
}

/* ================= FETCH EVENT ================= */
async function fetchEventFullDetails(eventID) {
  try {
    const [eventRes, ticketRes] = await Promise.all([
      axios.get(
        `https://www.eventbriteapi.com/v3/events/${eventID}/`,
        {
          params: {
            expand: "organizer,category,subcategory,venue",
            token: TOKEN
          }
        }
      ),

      axios.get(
        `https://www.eventbriteapi.com/v3/events/${eventID}/ticket_classes/`,
        {
          params: {
            token: TOKEN
          }
        }
      )
    ]);

    const event = eventRes.data;
    const tickets = ticketRes.data?.ticket_classes || [];

    // ✅ attach tickets to event
    event.ticket_classes = tickets;

    // ✅ extract useful info (optional)
    event.min_price = tickets.length
      ? Math.min(...tickets.map(t => parseFloat(t.cost?.major_value || 0)))
      : 0;

    return event;

  } catch (err) {
    console.log(`❌ API failed for ${eventID}`, err.response?.status);
    return null;
  }
}

/* ================= SAVE TO DB ================= */
async function saveEvent(event) {
  try {
    await pool.request()
      .input("eventbriteID", sql.NVarChar(255), String(event.id))
      .input("title", sql.NVarChar(4000), event.name?.text || "")
      .input("desc", sql.NVarChar(sql.MAX), event.description?.text || null)
      .input("start", sql.DateTime, event.start?.local || null)
      .input("end", sql.DateTime, event.end?.local || null)
      .input("address", sql.NVarChar(1000), event.venue?.address?.localized_address_display || null)
      .input("city", sql.NVarChar(255), event.venue?.address?.city || null)
      .input("state", sql.NVarChar(255), event.venue?.address?.region || null)
      .input("zip", sql.NVarChar(20), event.venue?.address?.postal_code || null)
      .input("org", sql.NVarChar(255), event.organizer?.name || null)
      .input("loc", sql.NVarChar(1000), event.venue?.name || null)
      .input("url", sql.NVarChar(sql.MAX), event.url || null)
      .input("capacity", sql.Int, event.capacity || 0)
      .input("country", sql.NVarChar(255), event.venue?.address?.country || null)
      .input("eventSource", sql.NVarChar(255), "eventbrite")
      .query(`
        IF NOT EXISTS (SELECT 1 FROM event WHERE eventbriteID = @eventbriteID)
        INSERT INTO event (
          eventbriteID, event_title, event_desc, edate, EventEndDate,
          address, city, state, zipcode,
          contact_name, location, url, numberOfseats,
          country, eventSource
        )
        VALUES (
          @eventbriteID, @title, @desc, @start, @end,
          @address, @city, @state, @zip,
          @org, @loc, @url, @capacity,
          @country, @eventSource
        )
      `);

  } catch (err) {
    console.log("⚠️ Save failed:", event.id);
  }
}

/* ================= MAIN SEARCH API ================= */
/* ================= MAIN SEARCH API ================= */
app.get("/search", async (req, res) => {
  try {
    const q = req.query.q;

    if (!q || typeof q !== "string") {
      return res.status(400).json({ error: "Invalid query" });
    }

    const input = q.trim();

    console.log("🔍 Search:", input);

    /* =========================================
       STEP 1 → CHECK DB FIRST
    ========================================= */

    let dbQuery;

    // if numeric → search by eventbriteID
    if (/^\d+$/.test(input)) {

      dbQuery = await pool.request()
        .input("id", sql.NVarChar, input)
        .query(`
          SELECT * 
          FROM event
          WHERE eventbriteID = @id
        `);

    } else {

      // title search
      dbQuery = await pool.request()
        .input("title", sql.NVarChar, `%${input}%`)
        .query(`
          SELECT *
          FROM event
          WHERE event_title LIKE @title
        `);
    }

    // ✅ FOUND IN DB
    if (dbQuery.recordset.length > 0) {
      console.log("✅ Found in DB");
      return res.json(dbQuery.recordset);
    }

    console.log("❌ Not in DB");

    /* =========================================
       STEP 2 → IF ID → DIRECT API CALL
    ========================================= */

    if (/^\d+$/.test(input)) {

      const event = await fetchEventFullDetails(input);

      if (!event) {
        return res.json([]);
      }

      await saveEvent(event);

      return res.json([event]);
    }

    /* =========================================
       STEP 3 → TITLE → SCRAPE IDS
    ========================================= */

    const ids = await extractIdsFromSearch(input);

if (ids.length === 0) {
  return res.json([]);
}

    /* =========================================
       STEP 4 → FETCH EVENT DETAILS
    ========================================= */

    const events = [];

    for (const id of ids) {

      const event = await fetchEventFullDetails(id);

      if (event) {

        events.push(event);

        // save one by one
        await saveEvent(event);
      }
    }

    return res.json(events);

  } catch (err) {

    console.error("❌ SEARCH ERROR:");
    console.error(err);

    return res.status(500).json({
      error: err.message
    });
  }
});
/*
app.get("/fetch-from-eventbrite", async (req, res) => {
  try {
    const slug = req.query.slug;

    if (!slug) return res.json([]);

    const ids = await extractIdsFromSlug(slug);

    let events = [];

    for (const id of ids) {
      const event = await fetchEventFullDetails(id);
      if (event) events.push(event);
    }

    return res.json(events);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
*/
/* ================= START ================= */
async function startServer() {
  await connectDB();

  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

startServer();
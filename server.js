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
  const matches = [...html.matchAll(/eventbrite\.com\/e\/.*?-tickets-(\d+)/g)];
  return [...new Set(matches.map(m => m[1]))];
}

// locations to try
const locations = [
  "online",
  "united-states",
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
app.get("/search", async (req, res) => {
  const q = req.query.q;

  // 1. check DB first
  const dbResult = await getFromDB(q);

  // IMPORTANT: correct empty check
  if (dbResult && dbResult.length > 0) {
    return res.json(dbResult); // STOP HERE
  }

  // 2. determine input type
  const isEventbriteId = q.length > 10 && /^\d+$/.test(q);

  let apiData;

  if (isNumericId) {
    // ID → direct Eventbrite API
    apiData = await fetchEventById(q);
  } else {
    // title → scraper → slug → eventbrite search
    const slug = toSlug(q);
    apiData = await scrapeEvent(slug);
  }

  // 3. save into DB
  if (apiData && apiData.length > 0) {
    await saveToDB(apiData);
  }

  // 4. return final result
  return res.json(apiData);
});

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

/* ================= START ================= */
async function startServer() {
  await connectDB();

  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

startServer();
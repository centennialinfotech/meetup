import dotenv from "dotenv";
dotenv.config();

import express from "express";
import sql from "mssql";
import cors from "cors";
import axios from "axios";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ================= DB CONFIG =================
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

// ================= CONNECT DB =================
async function connectDB() {
  pool = await sql.connect(dbConfig);
  console.log("✅ DB Connected");
}

// ================= HELPERS =================

// slug generator
function createSlug(title) {
  return title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

// extract IDs from listing page
function extractEventIds(html) {
  const matches = [...html.matchAll(/eventbrite\.com\/e\/.*?-tickets-(\d+)/g)];
  return [...new Set(matches.map(m => m[1]))];
}

// simple match
function isMatch(search, title) {
  return title.toLowerCase().includes(search.toLowerCase());
}

// ================= FETCH FROM EVENTBRITE =================

// Step 1: scrape listing pages
async function getEventIdsFromSlug(slug) {
  const locations = [
    "online",
    "united-states",
    "india",
    "united-kingdom",
    "india--delhi",
    "india--mumbai"
  ];

  let ids = [];

  for (const loc of locations) {
    for (let page = 1; page <= 3; page++) {
      try {
        const url = `https://www.eventbrite.com/d/${loc}/${slug}/?page=${page}`;

        console.log("🌍 Fetch:", url);

        const res = await axios.get(url, {
          headers: { "User-Agent": "Mozilla/5.0" }
        });

        const found = extractEventIds(res.data);

        if (found.length) {
          console.log(`✅ Found ${found.length} IDs`);
          ids.push(...found);
        }

      } catch (err) {
        console.log("⚠️ Skip:", loc, page);
      }
    }
  }

  return [...new Set(ids)];
}

// Step 2: fetch event details
async function getEventDetails(ids) {
  if (!ids.length) return [];

  try {
    const res = await axios.get(
      "https://www.eventbrite.com/api/v3/destination/events/",
      {
        params: {
          event_ids: ids.join(","),
          page_size: ids.length,
          expand: "event_sales_status,image,primary_venue"
        },
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json"
        }
      }
    );

    return res.data?.events || [];

  } catch (err) {
    console.log("❌ API blocked");
    return [];
  }
}

// Step 3: save into DB
async function saveEvent(event) {
  try {
    const request = pool.request();

    const venue = event.primary_venue || {};
    const addr = venue.address || {};

    await request
      .input("eventbriteID", sql.NVarChar(255), String(event.id))
      .input("title", sql.NVarChar(4000), event.name?.text || "")
      .input("desc", sql.NVarChar(sql.MAX), event.description?.text || null)
      .input("start", sql.DateTime, event.start?.local || null)
      .input("end", sql.DateTime, event.end?.local || null)
      .input("address", sql.NVarChar(1000), addr.localized_address_display || null)
      .input("city", sql.NVarChar(255), addr.city || null)
      .input("state", sql.NVarChar(255), addr.region || null)
      .input("zip", sql.NVarChar(20), addr.postal_code || null)
      .input("org", sql.NVarChar(255), event.primary_organizer?.name || null)
      .input("loc", sql.NVarChar(1000), venue.name || null)
      .input("status", sql.Bit, 1)
      .input("racc", sql.TinyInt, 0)
      .input("url", sql.NVarChar(sql.MAX), event.url || null)
      .input("fee", sql.Decimal(10, 2), 0)
      .input("cat", sql.NVarChar(255), null)
      .input("sub", sql.NVarChar(255), null)
      .input("capacity", sql.Int, event.capacity || 0)
      .input("country", sql.NVarChar(255), addr.country || null)
      .input("eventSource", sql.NVarChar(255), "eventbrite")
      .query(`
        INSERT INTO event (
          eventbriteID, event_title, event_desc, edate, EventEndDate,
          address, city, state, zipcode, contact_name, location,
          status, racc, url, fee, event_type, event_subType,
          numberOfseats, country, eventSource
        )
        VALUES (
          @eventbriteID, @title, @desc, @start, @end,
          @address, @city, @state, @zip, @org, @loc,
          @status, @racc, @url, @fee, @cat, @sub,
          @capacity, @country, @eventSource
        )
      `);

    console.log("💾 Saved:", event.name?.text);

  } catch (err) {
    console.log("⚠️ Save skipped (duplicate?)");
  }
}

// ================= SEARCH API =================

app.get("/fetch-from-eventbrite", async (req, res) => {
  try {
    const slug = req.query.slug;

    if (!slug) return res.json([]);

    const locations = [
      "online",
      "united-states",
      "india",
      "united-kingdom"
    ];

    let foundEvents = [];

    for (const loc of locations) {
      const url = `https://www.eventbrite.com/d/${loc}/${slug}/`;

      console.log("🌍 Fetching:", url);

      const html = await fetch(url).then(r => r.text());

      const ids = [...html.matchAll(/eventbrite\.com\/e\/.*?-tickets-(\d+)/g)]
        .map(m => m[1]);

      if (ids.length > 0) {
        foundEvents = ids;
        break;
      }
    }

    // ❗ Return IDs only for now
    res.json(foundEvents);

  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ================= START =================
async function start() {
  await connectDB();

  app.listen(3000, () => {
    console.log("🚀 Server running on 3000");
  });
}

start();
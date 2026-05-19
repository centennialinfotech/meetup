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
    trustServerCertificate: true,
  },
};

let pool;

/* ================= CONNECT DB ================= */
async function connectDB() {
  pool = await sql.connect(dbConfig);
  console.log("✅ DB Connected");
}

/* ================= HELPERS ================= */

function isEventId(input) {
  return /^\d+$/.test(input);
}

/* CLEAN SLUG */
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

/* NORMALIZE */
function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ================= EVENTBRITE HTML PARSER ================= */
/**
 * IMPORTANT:
 * We ONLY extract:
 * https://www.eventbrite.com/e/{slug}-tickets-{id}
 */
function extractEventCandidates(html) {
  const candidates = [];

  const regex =
    /https:\/\/www\.eventbrite\.com\/e\/([^"' ]+)-tickets-(\d+)/g;

  let match;

  while ((match = regex.exec(html)) !== null) {
    const slug = match[1];
    const id = match[2];

    candidates.push({
      id,
      slug,
      normalized: normalize(slug),
    });
  }

  return candidates;
}

/* ================= BEST MATCH LOGIC ================= */
function pickBestCandidate(candidates, inputSlug) {
  let best = null;
  let bestScore = 0;

  for (const c of candidates) {
    const candidateSlug = c.normalized;

    /* 🔥 STRICT MATCH (MOST IMPORTANT) */
    if (candidateSlug === inputSlug) {
      return c;
    }

    if (candidateSlug.includes(inputSlug)) {
      return c;
    }

    /* fallback similarity */
    const score = similarity(candidateSlug, inputSlug);

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return bestScore >= 0.6 ? best : null;
}

/* SIMPLE SIMILARITY */
function similarity(a, b) {
  const aWords = a.split(" ");
  const bWords = b.split(" ");

  const match = aWords.filter((w) => bWords.includes(w)).length;

  return match / Math.max(aWords.length, bWords.length);
}

/* ================= SCRAPER ================= */
const locations = [
  "online",
  "united-states",
  "ca--san-diego",
  "india",
  "united-kingdom",
  "ny--new-york",
  "ca--los-angeles",
  "il--chicago",
  "tx--houston",
  "az--phoenix",
  "pa--philadelphia",
  "tx--san-antonio",
  "ca--san-diego",
  "tx--dallas",
  "ca--san-jose",
  "tx--austin",
  "fl--jacksonville",
  "tx--fort-worth",
  "oh--columbus",
  "nc--charlotte",
  "ca--san-francisco",
  "in--indianapolis",
  "wa--seattle",
  "co--denver",
  "dc--washington",
  "ma--boston",
  "tx--el-paso",
  "tn--nashville",
  "mi--detroit",
  "ok--oklahoma-city",
  "or--portland",
  "nv--las-vegas",
  "tn--memphis",
  "ky--louisville",
  "md--baltimore",
  "wi--milwaukee",
  "nm--albuquerque",
  "az--tucson",
  "ca--fresno",
  "ca--sacramento",
  "az--mesa",
  "ga--atlanta",
  "mo--kansas-city",
  "co--colorado-springs",
  "fl--miami",
  "nc--raleigh",
  "ne--omaha",
  "ca--long-beach",
  "va--virginia-beach",
  "ca--oakland",
  "mn--minneapolis",
  "ok--tulsa",
  "tx--arlington",
  "fl--tampa",
  "la--new-orleans",
  "ks--wichita",
  "oh--cleveland",
  "ca--bakersfield",
  "hi--honolulu",
  "ca--anaheim",
  "co--aurora",
  "ca--santa-ana",
  "ca--riverside",
  "tx--corpus-christi",
  "ky--lexington",
  "ca--stockton",
  "nv--henderson",
  "mn--saint-paul",
  "mo--st-louis",
  "oh--cincinnati",
  "pa--pittsburgh",
  "nc--greensboro",
  "ak--anchorage",
  "tx--plano",
  "ne--lincoln",
  "fl--orlando",
  "ca--irvine",
  "nj--newark",
  "nc--durham",
  "ca--chula-vista",
  "oh--toledo",
  "in--fort-wayne",
  "fl--st-petersburg",
  "tx--laredo",
  "nj--jersey-city",
  "az--chandler",
  "wi--madison",
  "tx--lubbock",
  "az--scottsdale",
  "nv--reno",
  "ny--buffalo",
  "az--gilbert",
  "ca--glendale",
  "nv--north-las-vegas",
  "nc--winston-salem",
  "va--chesapeake",
  "va--norfolk",
  "ca--fremont",
  "tx--garland",
  "tx--irving",
  "fl--hialeah",
  "va--richmond",
  "id--boise",
  "wa--spokane",  
];

async function extractIdsFromSearch(input) {
  const inputSlug = normalize(toSlug(input));

  for (const loc of locations) {
    const url = `https://www.eventbrite.com/d/${loc}/${toSlug(input)}/`;

    try {
      console.log("🌍 SCRAPING:", url);

      const res = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const candidates = extractEventCandidates(res.data);

      console.log("CANDIDATES FOUND:", candidates.length);

      const best = pickBestCandidate(candidates, inputSlug);

      if (best) {
        console.log("✅ MATCHED EVENT:", best.slug, best.id);
        return [best.id];
      }
    } catch (err) {
      console.log("❌ FAILED:", loc);
    }
  }

  return [];
}

/* ================= EVENT DETAILS API ================= */
async function fetchEventFullDetails(eventID) {
  try {
    const [eventRes, ticketRes] = await Promise.all([
      axios.get(`https://www.eventbriteapi.com/v3/events/${eventID}/`, {
        params: {
          expand: "organizer,category,subcategory,venue",
          token: TOKEN,
        },
      }),

      axios.get(
        `https://www.eventbriteapi.com/v3/events/${eventID}/ticket_classes/`,
        {
          params: { token: TOKEN },
        }
      ),
    ]);

    const event = eventRes.data;
    const tickets = ticketRes.data?.ticket_classes || [];

    event.ticket_classes = tickets;

    return event;
  } catch (err) {
    console.log("❌ API FAILED:", eventID);
    return null;
  }
}

/* ================= DB SAVE ================= */
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
      .input("country", sql.NVarChar(255), event.venue?.address?.country || null)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM event WHERE eventbriteID = @eventbriteID)
        INSERT INTO event (
          eventbriteID, event_title, event_desc, edate, EventEndDate,
          address, city, state, zipcode,
          contact_name, location, url,
          country, eventSource
        )
        VALUES (
          @eventbriteID, @title, @desc, @start, @end,
          @address, @city, @state, @zip,
          @org, @loc, @url,
          @country, 'eventbrite'
        )
      `);
  } catch (err) {
    console.log("⚠️ DB SAVE FAILED:", event.id);
  }
}

/* ================= MAIN API ================= */
app.get("/search", async (req, res) => {
  try {
    const q = req.query.q?.trim();
    if (!q) return res.status(400).json({ error: "Invalid query" });

    console.log("🔥 SEARCH:", q);

    /* STEP 1: DB CHECK */
    let dbResult;

    if (isEventId(q)) {
      dbResult = await pool.request()
        .input("id", sql.NVarChar, q)
        .query(`SELECT * FROM event WHERE eventbriteID = @id`);
    } else {
      dbResult = await pool.request()
        .input("title", sql.NVarChar, `%${q}%`)
        .query(`SELECT * FROM event WHERE event_title LIKE @title`);
    }

    if (dbResult.recordset.length > 0) {
      return res.json(dbResult.recordset);
    }

    /* STEP 2: ID DIRECT */
    if (isEventId(q)) {
      const event = await fetchEventFullDetails(q);
      if (!event) return res.json([]);

      await saveEvent(event);
      return res.json([event]);
    }

    /* STEP 3: SCRAPE */
    const ids = await extractIdsFromSearch(q);

    if (!ids.length) return res.json([]);

    const events = [];

    for (const id of ids) {
      const event = await fetchEventFullDetails(id);
      if (event) {
        events.push(event);
        await saveEvent(event);
      }
    }

    return res.json(events);

  } catch (err) {
    console.error("❌ SEARCH ERROR:", err);
    return res.status(500).json({ error: err.message });
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
import axios from "axios";
import sql from "mssql";
let pool;
const dbConfig = {
  user: "",
  password: "",              // ✅ password here
  server: "",      // ✅ server here
  database: "",
  options: {
    encrypt: true,
    trustServerCertificate: true
  }
};

const url = "https://www.meetup.com/gql2";

const payload = {
  operationName: "recommendedEventsWithSeries",
  variables: {
    first: 12,
    lat: 37.779998779296875,
    lon: -122.41999816894531,
    topicCategoryId: "652",
    radius: 25,
    startDateRange: "2026-05-15T03:00:00-04:00",
    endDateRange: "2026-05-16T02:59:59-04:00",
    eventType: "PHYSICAL",
    numberOfEventsForSeries: 5,
    seriesStartDate: "2026-05-15",
    sortField: "RELEVANCE",
    doConsolidateEvents: true,
    doPromotePaypalEvents: false,
    indexAlias: "",
    dataConfiguration: JSON.stringify({
      isSimplifiedSearchEnabled: true,
      include_events_from_user_chapters: true
    })
  },
  extensions: {
    persistedQuery: {
      version: 1,
      sha256Hash: "3f7480361301be1b3208df0cd724930a22f7741d3c24666ab5b37a381ff4e0e8"
    }
  }
};

const headers = {
  "content-type": "application/json",
  "accept": "*/*",
  "origin": "https://www.meetup.com",
  "referer": "https://www.meetup.com/find/",
  "user-agent": "Mozilla/5.0",

  // 🔴 IMPORTANT: use your cookie (shortened version works fine)
  "cookie": "MEETUP_BROWSER_ID=YOUR_ID; MEETUP_MEMBER_LOCATION=city=San+Francisco"
};


async function insertMeetupEvent(pool, ev) {
  try {
    const venue = ev.venue || {};

    const title = ev.title || "";
    const desc = ev.description || null;

    const start = ev.dateTime || null;
    const end = null;

    const address = venue?.address || null;
    const city = venue?.city || null;
    const state = venue?.state || null;
    const country = venue?.country || null;

    const zipcode = null;

    const organizer = ev?.group?.name || null;

    const location = `${city || ""} ${state || ""}`.trim();

    const statusBit = 1;
    const racc = 0;

    const fee = 0;

    const category = null;
    const subcategory = null;

    const capacity = ev.maxTickets || 0;

    const eventSource = "MEETUP";

    await pool.request()
      .input("eventbriteID", sql.NVarChar(255), String(ev.id))
      .input("title", sql.NVarChar(4000), title)
      .input("desc", sql.NVarChar(sql.MAX), desc)
      .input("start", sql.DateTime, start)
      .input("end", sql.DateTime, end)
      .input("address", sql.NVarChar(1000), address)
      .input("city", sql.NVarChar(255), city)
      .input("state", sql.NVarChar(255), state)
      .input("zip", sql.NVarChar(20), zipcode)
      .input("org", sql.NVarChar(255), organizer)
      .input("loc", sql.NVarChar(1000), location)
      .input("status", sql.Bit, statusBit)
      .input("racc", sql.TinyInt, racc)
      .input("url", sql.NVarChar(sql.MAX), ev.eventUrl || null)
      .input("fee", sql.Decimal(10, 2), fee)
      .input("cat", sql.NVarChar(255), category)
      .input("sub", sql.NVarChar(255), subcategory)
      .input("capacity", sql.Int, capacity)
      .input("country", sql.NVarChar(255), country)
      .input("eventSource", sql.NVarChar(255), eventSource)
      .query(`
        INSERT INTO event (
  eventbriteID,event_title,event_desc,edate,EventEndDate,address,city,state,zipcode,
  contact_name,location,status,raccurance,url,fee,event_type,event_subType,
  CompanyName,numberOfseats,content,country,eventSource
)
SELECT
  @eventbriteID,@title,@desc,@start,@end,@address,@city,@state,@zip,
  @org,@loc,@status,@racc,@url,@fee,@cat,@sub,
  @org,@capacity,@desc,@country,@eventSource
WHERE NOT EXISTS (
  SELECT 1 FROM event WHERE eventbriteID = @eventbriteID
);
      `);

    console.log("✅ Inserted:", title);

  } catch (err) {
    console.error("❌ DB Insert Failed:", ev.title, err.message);
  }
}

async function fetchMeetupEvents() {
  try {
    const res = await axios.post(url, payload, { headers });

    const events = res.data?.data?.result?.edges || [];

    console.log("✅ Total events:", events.length, "\n");
    const seen = new Set();

for (const e of events) {
  const id = e.node.id;

  if (seen.has(id)) continue;
  seen.add(id);

  await insertMeetupEvent(pool, e.node);
}
    // 👉 pagination info
    const pageInfo = res.data?.data?.result?.pageInfo;
    if (pageInfo?.hasNextPage) {
      console.log("➡️ Next Cursor:", pageInfo.endCursor);
    }

  } catch (err) {
     if (err.message.includes("UQ_event_eventbriteID")) {
    console.log("⚠️ Skipped duplicate:", ev.id);
  } else {
    console.error("❌ DB Insert Failed:", ev.title, err.message);
  }
  }
}

async function start() {
  try {
    pool = await sql.connect(dbConfig);
    console.log("✅ DB Connected");

    await fetchMeetupEvents();

  } catch (err) {
    console.error("❌ Startup Failed:", err.message);
  }
}

start();

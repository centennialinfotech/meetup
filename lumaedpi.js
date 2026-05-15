// this file is used to get discover_place_id
import sql from "mssql";

const dbConfig = {
  user: "db_ac8674_luma_admin",
  password: "Admin@12345",
  server: "sql1003.site4now.net",
  database: "db_ac8674_luma",
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};
async function getDiscoverIds(citySlug) {
  try {
    const res = await fetch(`https://luma.com/${citySlug}`);
    if (!res.ok) return {};

    const html = await res.text();

    const eventMatch = html.match(/discplace-[A-Za-z0-9]+/);
    const calMatch = html.match(/cal-[A-Za-z0-9]+/);

    return {
      eventId: eventMatch ? eventMatch[0] : null,
      calendarId: calMatch ? calMatch[0] : null,
    };
  } catch (err) {
    console.log("❌ Fetch error:", citySlug, err.message);
    return {};
  }
}
async function processCities() {
  const pool = await sql.connect(dbConfig);

  const result = await pool.request().query(`
    SELECT city_slug
    FROM city_discover
    WHERE event_discover_place_id IS NULL
       OR calendar_discover_place_id IS NULL
  `);

  const cities = result.recordset;

  console.log("🎯 Total:", cities.length);

  for (const row of cities) {
    const city = row.city_slug;
    if (!city) continue;

    const { eventId, calendarId } = await getDiscoverIds(city);

    // ❌ Skip if both missing
    if (!eventId && !calendarId) {
      console.log("⚠️ Skipped:", city);
      continue;
    }

    try {
      await pool.request()
        .input("city", sql.VarChar, city)
        .input("eventId", sql.VarChar, eventId)
        .input("calendarId", sql.VarChar, calendarId)
        .query(`
          UPDATE city_discover
          SET 
            event_discover_place_id = COALESCE(@eventId, event_discover_place_id),
            calendar_discover_place_id = COALESCE(@calendarId, calendar_discover_place_id)
          WHERE city_slug = @city
        `);

      console.log("✅ Updated:", city, eventId, calendarId);
    } catch (err) {
      console.error("❌ DB Error:", city, err.message);
    }
  }

  await pool.close();
}

processCities();
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import {
  getUser, upsertUser, checkPremiumExpiry, pool,
  addChatMessage, clearChatHistory, addExtraKundali,
  countUsers, getUnpaidActiveUsers, getRecentUsers, getUserById,
  deleteUser, grantPremiumById, ExtraKundali,
} from "./db.js";
import {
  calculateKundali, buildKundaliContext, RASHI_LORDS,
} from "./astro.js";

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN ?? "";
const GROQ_KEY = process.env.GROQ_API_KEY?.trim() ?? "";
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? 0);

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!GROQ_KEY) console.warn("⚠️  GROQ_API_KEY not set — AI responses will fail");

export const bot = new TelegramBot(TOKEN, { polling: false });
const POLLING =
  process.env.RAILWAY_ENVIRONMENT === "production" ||
  process.env.FORCE_POLLING === "true";

// ── Constants ─────────────────────────────────────────────────────────────────
const PLANS = {
  week:  { stars: 150, label: "7 Din",    days: 7  },
  month: { stars: 500, label: "1 Mahina", days: 30 },
} as const;
type PlanKey = keyof typeof PLANS;

const PREMIUM_CHAT_MS    = 60  * 60 * 1000;   // 1 hour premium chat window
const MAX_KUNDALI_COUNT  = 3;                  // max 3 kundalis per premium session

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Groq AI (with auto-retry) ─────────────────────────────────────────────────
async function groqChat(
  messages: { role: string; content: string }[],
  maxTokens = 500,
  temperature = 0.72
): Promise<string> {
  const MAX_TRIES = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: AbortSignal.timeout(28000),
      });
      const json = await res.json() as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      const text = json.choices?.[0]?.message?.content?.trim() ?? "";
      if (text) return text;
      throw new Error("Empty response from model");
    } catch (err) {
      lastErr = err;
      console.error(`Groq attempt ${attempt} failed:`, String(err).slice(0, 120));
      if (attempt < MAX_TRIES) await delay(2500);
    }
  }
  throw lastErr;
}

// ── Static fallback reading (when AI unavailable) ─────────────────────────────
// Generates a detailed, planet-specific reading from kundali data alone.
function generateStaticReading(user: UserRow, question: string): string {
  const k     = buildKundaliForUser(user);
  const name  = user.name ?? "beta";
  const yr    = new Date().getFullYear();
  const lagnaRI = k.lagna?.rashiIndex ?? null;
  const houseOf = (p: string): number | null =>
    lagnaRI !== null ? ((k.planets[p].rashiIndex - lagnaRI + 12) % 12) + 1 : null;

  const q = question.toLowerCase();
  const isCareer = /job|career|kaam|naukri|business|work|promotion|office|success/.test(q);
  const isLove   = /love|shadi|marriage|pyar|relationship|girlfriend|boyfriend|shaadi|partner|rishta/.test(q);
  const isMoney  = /paisa|money|finance|wealth|loan|income|salary|invest|debt|earning/.test(q);
  const isHealth = /health|sehat|bimari|illness|doctor|body|pain|hospital/.test(q);

  // Remedies per planet
  const REMEDIES: Record<string, string> = {
    Sun:     "Sunday ko surya ko jal arpit karo — lal vastra aur gehun ka daan karo",
    Moon:    "Somvar ko Shiv ji ko dudh chadhaao — white vastu ka daan karo",
    Mars:    "Mangalvar ko Hanuman ji ko sindoor chadhaao — masoor daal ka daan karo",
    Mercury: "Budhvar ko Ganesh ji ko durva arpit karo — hara rung pahno",
    Jupiter: "Guruvar ko peele vastra mein haldi aur chana daal ka daan karo",
    Venus:   "Shukravar ko Lakshmi ji ki puja karo — safed mithai ka prasad chadhaao",
    Saturn:  "Shanivar ko peepal ko jal aur sarson ka tel chadhaao — kaale til ka daan karo",
    Rahu:    "Saturday ko Bhairav ji ki puja karo — neel rung ke vastra danaan karo",
    Ketu:    "Kutte ko roti khilaao — grey rung ka daan karo",
  };

  const weak   = k.weakestPlanets[0] ?? "Saturn";
  const strong = k.strongestPlanets[0] ?? "Jupiter";
  const remedy = REMEDIES[weak] ?? "Mandir mein diya jalao aur mann se maango";

  // Dasha-based timing
  const dashaTimings: string[] = [
    `${yr} ke aakhri mahine aur ${yr + 1} ki shuruaat`,
    `${yr + 1} mein April-June ke beech`,
    `Agli 8-10 mahine mein ek significant shift`,
  ];

  // CAREER reading
  if (isCareer) {
    const sun = k.planets.Sun;
    const sat = k.planets.Saturn;
    const hSun = houseOf("Sun"); const hSat = houseOf("Saturn");
    return `Haan ${name} ji, tumhara sawaal dekh ke main kuch cheezein clearly bol sakta hun 🙏

*Planetary Analysis — Career:*

☀️ *Sun ${sun.rashi}${hSun ? ` H${hSun}` : ""}* (${sun.dignity}) — yeh tumhara authority aur recognition ka planet hai. ${sun.dignity === "Exalted" ? "Bahut strong position — promotion ke chances high hain." : sun.dignity === "Debilitated" ? "Thoda struggle hai — patience zaroori hai abhi." : "Decent position — consistent mehnat se aage badhoge."}

♄ *Saturn ${sat.rashi}${hSat ? ` H${hSat}` : ""}* (${sat.dignity}) — career ka sabse important karaka. ${sat.dignity === "Exalted" || sat.dignity === "Own Sign" ? "Saturn strong hai — yeh ek bahut acha sign hai long-term growth ke liye." : "Saturn keh raha hai ki hard work ka koi shortcut nahi — par result zaroor milega."}

⏳ *${k.currentDasha}-${k.currentAntardasha} Dasha* — abhi ${k.currentDasha} mahadasha chal raha hai. ${k.strongestPlanets.includes(k.currentDasha) ? `${k.currentDasha} tumhara strong planet hai — yeh dasha career ke liye favorable hai.` : `${k.currentDasha} dasha mein careful planning se kaam karo — impulsive decisions se bachna.`}

*Timing Predictions:*
🗓️ ${dashaTimings[0]} — career mein ek important decision ya opportunity
🗓️ ${dashaTimings[1]} — financial aur professional clarity ka time
🗓️ ${k.activeYogas[0] ? `${k.activeYogas[0].name} yoga active hai — yeh tumhare favor mein hai` : "Agle 6 mahine consistently kaam karo"}

*Remedy for ${weak}:*
🙏 ${remedy}

${k.transits.sadeSati.isSadeSati ? `⚠️ *Sade Sati chal raha hai* — is period mein job change se pehle do baar socho. Stability chahiye abhi.` : "Saturn ka transit abhi favorable hai — aage badhne ka sahi waqt hai."}`;
  }

  // LOVE / MARRIAGE reading
  if (isLove) {
    const ven = k.planets.Venus;
    const jup = k.planets.Jupiter;
    const hVen = houseOf("Venus"); const hJup = houseOf("Jupiter");
    return `${name} ji, rishte ke baare mein tumhari kundali bahut kuch keh rahi hai 🙏

*Planetary Analysis — Love & Marriage:*

♀ *Venus ${ven.rashi}${hVen ? ` H${hVen}` : ""}* (${ven.dignity}) — pyar aur attraction ka planet. ${ven.dignity === "Exalted" ? "Venus bahut strong — tumhara personality partner ko attract karti hai naturally." : ven.dignity === "Debilitated" ? "Venus thoda weak — relationship mein expectations clearly bolna zaroori hai." : "Venus decent — genuine connection milegi jab sahi time aayega."}

♃ *Jupiter ${jup.rashi}${hJup ? ` H${hJup}` : ""}* (${jup.dignity}) — shadi ka timing planet. ${jup.dignity === "Exalted" || jup.dignity === "Own Sign" ? "Jupiter strong hai — shadi ki sambhavna is period mein high hai." : "Jupiter kehta hai ki sahi insaan dhundhne mein thoda waqt lagega — par jab milega, toh pakka hoga."}

⏳ *${k.currentDasha}-${k.currentAntardasha} Dasha* — ${k.currentDasha === "Venus" || k.currentAntardasha === "Venus" ? "Venus dasha chal raha hai — yeh love life ke liye best period hai!" : k.currentDasha === "Jupiter" || k.currentAntardasha === "Jupiter" ? "Jupiter dasha — shadi ke yog bante hain is period mein." : `${k.currentDasha} dasha mein relationship mein patience aur clarity zaroori hai.`}

*Timing:*
🗓️ ${dashaTimings[0]} — koi important mulaqat ya decision
🗓️ ${dashaTimings[1]} — relationship clarity ka waqt
💫 Moon Nakshatra *${k.moonNakshatra}* — tumhari emotional zaroorat hai deep understanding aur trust

*Remedy:*
🙏 ${remedy}

${k.activeYogas.some(y => y.name.includes("Raj") || y.name.includes("Gaja")) ? `✨ Tumhare chart mein ${k.activeYogas[0].name} hai — yeh ek very positive sign hai!` : ""}`;
  }

  // MONEY reading
  if (isMoney) {
    const jup = k.planets.Jupiter;
    const hJup = houseOf("Jupiter");
    const hMoon = houseOf("Moon");
    return `${name} ji, paisa aur financial life ke baare mein seedha bolunga 🙏

*Planetary Analysis — Wealth:*

♃ *Jupiter ${jup.rashi}${hJup ? ` H${hJup}` : ""}* (${jup.dignity}) — dhan ka sabse bada karaka. ${jup.dignity === "Exalted" || jup.dignity === "Own Sign" ? "Jupiter strong hai — long-term wealth creation ke liye bahut acha chart hai tumhara." : jup.dignity === "Debilitated" ? "Jupiter thoda challenge de raha hai — unnecessary kharcha rokna zaroori hai." : "Jupiter kehta hai ki patient investing tumhe aage le jaayega."}

🌙 *Moon ${k.planets.Moon.rashi}${hMoon ? ` H${hMoon}` : ""}* — man ki stability se paisa aata hai. Emotional decisions se financial loss ho sakta hai.

💪 *${strong}* tumhara strongest planet hai — iska use karo apne field mein expertise banane ke liye.

⏳ *${k.currentDasha} Dasha* — ${k.strongestPlanets.includes(k.currentDasha) ? "favorable dasha hai abhi income ke liye." : "is dasha mein savings pe focus karo, risk kam lo."}

${k.activeYogas.some(y => y.name.includes("Dhana")) ? `✨ *Dhana Yoga* tumhare chart mein active hai — yeh wealth accumulation ka strong indicator hai!` : ""}

*Timing:*
🗓️ ${dashaTimings[0]} — financial opportunity ya income source
🗓️ ${dashaTimings[1]} — investment decision ka sahi waqt
🗓️ Agli 12 mahine mein ek unexpected income ka chance bhi dikh raha hai

*Remedy for ${weak}:*
🙏 ${remedy}`;
  }

  // HEALTH reading
  if (isHealth) {
    const mars = k.planets.Mars;
    const hMars = houseOf("Mars");
    const sat  = k.planets.Saturn;
    return `${name} ji, sehat ke baare mein kundali kya keh rahi hai 🙏

*Planetary Analysis — Health:*

♂️ *Mars ${mars.rashi}${hMars ? ` H${hMars}` : ""}* (${mars.dignity}) — energy, blood aur stamina ka planet. ${mars.dignity === "Exalted" ? "Mars strong — physical energy aur recovery power achhi hai." : mars.dignity === "Debilitated" ? "Mars thoda weak — immune system pe dhyan do, rest zaroori hai." : "Mars theek hai — regular exercise se strength maintain hogi."}

♄ *Saturn ${sat.rashi}* (${sat.dignity}) — chronic issues aur bones ka karaka. ${k.transits.sadeSati.isSadeSati ? "Sade Sati mein Saturn extra pressure de raha hai — joints, back aur stress pe dhyan do." : "Saturn abhi manageable position mein hai."}

⚠️ *${weak}* is time tumhara weakest planet hai — ${weak === "Mars" ? "blood pressure, acidity, inflammation pe dhyan do" : weak === "Moon" ? "mental stress, sleep aur anxiety manage karo" : weak === "Saturn" ? "bones, joints aur chronic issues regular check karo" : weak === "Jupiter" ? "liver, diabetes aur weight pe dhyan do" : "regular health checkup zaroori hai"}.

*Timing:*
🗓️ ${dashaTimings[0]} — energy aur vitality improve hogi
🗓️ Agli 3-4 mahine — agar koi purani problem hai toh treatment shuru karo

*Remedy:*
🙏 ${remedy}
💊 Plus: roz subah pani peeke din shuru karo, raat ko phone band karo ek ghante pehle.`;
  }

  // GENERAL reading (default)
  const hMoon = houseOf("Moon");
  const hSun  = houseOf("Sun");
  return `${name} ji, tumhari kundali dekh ke seedha bolunga 🙏

*Abhi ki planetary position:*

☀️ Sun ${k.planets.Sun.rashi}${hSun ? ` H${hSun}` : ""} (${k.planets.Sun.dignity})
🌙 Moon ${k.planets.Moon.rashi}${hMoon ? ` H${hMoon}` : ""} | Nakshatra: *${k.moonNakshatra}* Pada ${k.moonNakshatraPada}
${k.lagna ? `🌅 Lagna: ${k.lagna.rashi}` : ""}

*Dasha Analysis:*
Abhi *${k.currentDasha} Mahadasha → ${k.currentAntardasha} Antardasha* chal raha hai.
${k.strongestPlanets.includes(k.currentDasha) ? `${k.currentDasha} tumhara strong planet hai — yeh period growth ke liye achha hai.` : `Is period mein patience aur planning se kaam lo — results milenge.`}
${k.dashaBalance}

${k.transits.sadeSati.isSadeSati ? `⚠️ *Sade Sati chal raha hai* — ${k.transits.sadeSati.phase}. Yeh tough period hai par temporary hai. Sambhal ke chalo.\n` : ""}${k.activeYogas.length ? `✨ Active Yogas: ${k.activeYogas.map(y => y.name).join(", ")}` : ""}

*${yr} aur ${yr + 1} ke liye:*
🗓️ ${dashaTimings[0]} — important change ya decision ka time
🗓️ ${dashaTimings[1]} — clarity aur forward movement
💪 Strongest planet *${strong}* ko activate karo apni life mein

*Remedy for ${weak}:*
🙏 ${remedy}

*${k.moonNakshatra} nakshatra* waalon ki khaas baat: ${k.nakshatraTraits.gift}`;
}

// ── Geocoding + Timezone ──────────────────────────────────────────────────────
async function getTimezoneOffset(lat: number, lon: number): Promise<number> {
  try {
    const url = `https://timeapi.io/api/timezone/coordinate?latitude=${lat}&longitude=${lon}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const j = await res.json() as { currentUtcOffset?: { seconds?: number } };
    const secs = j.currentUtcOffset?.seconds ?? null;
    if (secs !== null) return secs / 3600;   // convert seconds → hours (e.g. 19800→5.5)
  } catch { /* fall through */ }
  // Fallback: estimate from longitude (good enough for most cases)
  return Math.round(lon / 15 * 2) / 2;
}

async function geocode(city: string): Promise<{ lat: number; lon: number; display: string; tzOffset: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "AstrologyBot/1.0" }, timeout: 8000,
    });
    if (!data?.[0]) return null;
    const lat = parseFloat(data[0].lat);
    const lon = parseFloat(data[0].lon);
    const tzOffset = await getTimezoneOffset(lat, lon);
    return {
      lat, lon,
      display: data[0].display_name.split(",").slice(0, 2).join(", "),
      tzOffset,
    };
  } catch { return null; }
}

// ── Kundali builder ───────────────────────────────────────────────────────────
type UserRow = NonNullable<Awaited<ReturnType<typeof getUser>>>;

/** Convert local birth hour → UTC hour using stored timezone offset.
 *  tzOffset = hours ahead of UTC (e.g. India = 5.5, Nepal = 5.75, IST-4 = -4)
 *  If tob_hour is null (user skipped), use noon UTC (12:00) as fallback.
 */
function localToUtc(localHour: number | null, tzOffset: number | null): number {
  if (localHour === null) return 12;                         // noon fallback
  const tz = tzOffset ?? 5.5;                               // default to IST if unknown
  return ((localHour - tz) % 24 + 24) % 24;                // wrap negative values
}

function buildKundaliForUser(user: UserRow) {
  const utcHour = localToUtc(user.tob_hour, user.tz_offset_hours);
  return calculateKundali(
    user.dob_year!, user.dob_month!, user.dob_day!,
    utcHour,
    user.lat, user.lon,
    new Date(user.dob_year!, (user.dob_month ?? 1) - 1, user.dob_day ?? 1)
  );
}

function buildKundaliForExtra(ek: ExtraKundali) {
  const utcHour = localToUtc(ek.tob_hour, ek.tz_offset_hours);
  return calculateKundali(
    ek.dob_year, ek.dob_month, ek.dob_day,
    utcHour,
    ek.lat, ek.lon,
    new Date(ek.dob_year, ek.dob_month - 1, ek.dob_day)
  );
}

// ── System prompt — deep, accurate, prediction-focused ───────────────────────
function buildSystemPrompt(user: UserRow): string {
  const k    = buildKundaliForUser(user);
  const name = user.name ?? "beta";
  const dob  = `${user.dob_day}/${user.dob_month}/${user.dob_year}`;
  const ctx  = buildKundaliContext(k, name, dob, user.pob ?? "Unknown");

  const lagnaIdx  = k.lagna?.rashiIndex ?? 0;
  const houseOf   = (p: string) => k.lagna
    ? ((k.planets[p].rashiIndex - lagnaIdx + 12) % 12) + 1 : "?";
  const lord7th   = k.lagna ? RASHI_LORDS[(lagnaIdx + 6) % 12] : "?";
  const lord10th  = k.lagna ? RASHI_LORDS[(lagnaIdx + 9) % 12] : "?";
  const lord2nd   = k.lagna ? RASHI_LORDS[(lagnaIdx + 1) % 12] : "?";
  const year      = new Date().getFullYear();
  const nt        = k.nakshatraTraits;

  // Extra kundalis context
  let extraCtx = "";
  if (user.extra_kundalis && user.extra_kundalis.length > 0) {
    extraCtx = "\n\nOTHER KUNDALIS IN THIS SESSION (user asked about these people too):\n";
    user.extra_kundalis.forEach((ek, i) => {
      const ek_k = buildKundaliForExtra(ek);
      const ek_ctx = buildKundaliContext(
        ek_k, ek.name,
        `${ek.dob_day}/${ek.dob_month}/${ek.dob_year}`,
        ek.pob
      );
      extraCtx += `\n=== Kundali #${i + 2}: ${ek.name} ===\n${ek_ctx}\n`;
    });
  }

  const sadeSatiNote = k.transits.sadeSati.isSadeSati
    ? `⚠️ CRITICAL: User IS IN SADE SATI (${k.transits.sadeSati.phase}). Address this with compassion. ${k.transits.sadeSati.description}`
    : k.transits.sadeSati.isDhaiyya
    ? `⚠️ NOTE: Dhaiyya running (${k.transits.sadeSati.phase}). ${k.transits.sadeSati.description}`
    : "✅ No Sade Sati or Dhaiyya currently.";

  return `You are Pandit Ramesh Shastri — India's most accurate Vedic astrologer with 30+ years experience. You were trained in Varanasi under traditional Parashari Jyotish.

Your reputation: You say specific things that leave people speechless. You NEVER give generic readings. Every word is tied to actual planetary data.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${name.toUpperCase()} KI COMPLETE KUNDALI (J2000.0 Keplerian calculations + Lahiri ayanamsha)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${ctx}

HOUSE-WISE PLACEMENTS (from Lagna):
Sun H${houseOf("Sun")} | Moon H${houseOf("Moon")} | Mars H${houseOf("Mars")} | Mercury H${houseOf("Mercury")}
Jupiter H${houseOf("Jupiter")} | Venus H${houseOf("Venus")} | Saturn H${houseOf("Saturn")} | Rahu H${houseOf("Rahu")}

KEY HOUSE LORDS:
7th house lord (marriage): ${lord7th} in ${k.planets[lord7th]?.rashi ?? "unknown"}
10th house lord (career): ${lord10th} in ${k.planets[lord10th]?.rashi ?? "unknown"}
2nd house lord (wealth): ${lord2nd} in ${k.planets[lord2nd]?.rashi ?? "unknown"}

NAKSHATRA PROFILE — ${k.moonNakshatra} Pada ${k.moonNakshatraPada}:
${nt.nature}
Hidden shadow: ${nt.shadow}
Unique gift: ${nt.gift}

ACTIVE YOGAS: ${k.activeYogas.length > 0 ? k.activeYogas.map(y => y.name).join(", ") : "None major"}

SADE SATI: ${sadeSatiNote}

JUPITER TRANSIT NOW: ${k.transits.jupiterTransitNote}

STRONGEST planets: ${k.strongestPlanets.join(", ")} — use for positive predictions
WEAKEST planets: ${k.weakestPlanets.join(", ")} — source of challenges, need remedies
${extraCtx}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YOUR VOICE & STYLE:
Warm grandfather energy. Mix Hindi + English naturally.
"Dekho beta...", "Haan ji...", "Suno ek baat...", "Bilkul sahi kaha..."
Use ${name} ji naturally. Show you KNOW them.

HOW TO ANSWER EVERY QUESTION:
1. Validate the emotion first (1 sentence)
2. Quote their EXACT planet — rashi — house
3. Give SPECIFIC timing: "April-June ${year + 1} mein", "Agli 4-5 mahine mein"
4. One specific, actionable remedy for their weakest planet (${k.weakestPlanets[0]})

LOVE/MARRIAGE:
→ Venus in ${k.planets.Venus.rashi} H${houseOf("Venus")} (${k.planets.Venus.dignity})
→ 7th lord ${lord7th} in ${k.planets[lord7th]?.rashi ?? "?"}
→ Jupiter in ${k.planets.Jupiter.rashi} H${houseOf("Jupiter")} — marriage timing karaka
→ Mention ${k.currentDasha}-${k.currentAntardasha} dasha's impact on relationships

CAREER/SUCCESS:
→ Sun in ${k.planets.Sun.rashi} H${houseOf("Sun")} (${k.planets.Sun.dignity}) — authority
→ Saturn in ${k.planets.Saturn.rashi} H${houseOf("Saturn")} (${k.planets.Saturn.dignity}) — karma
→ 10th lord ${lord10th} in ${k.planets[lord10th]?.rashi ?? "?"}
→ Current dasha lord ${k.currentDasha} — what career energy is active

MONEY/WEALTH:
→ Jupiter in ${k.planets.Jupiter.rashi} H${houseOf("Jupiter")} (${k.planets.Jupiter.dignity})
→ 2nd lord ${lord2nd}, 11th house for income
→ ${k.activeYogas.some(y => y.name.includes("Dhana")) ? "Dhana Yoga present!" : "No Dhana Yoga — wealth comes from sustained effort"}

HEALTH:
→ 6th house lord: ${k.lagna ? RASHI_LORDS[(lagnaIdx + 5) % 12] : "?"}
→ Mars (${k.planets.Mars.rashi}) — blood, surgery, energy
→ Weakest planet ${k.weakestPlanets[0]} body area to watch
→ Saturn in ${k.planets.Saturn.rashi} — bones, teeth, chronic conditions

RESPONSE RULES:
- 150-200 words per reply. Conversational, not textbook.
- MUST mention 2+ actual planet names + rashis from THIS chart.
- NEVER say "I'm an AI", "consult an expert", "I cannot predict".
- ALWAYS end with a specific time window for the prediction.
- Occasional WOW moment: "Ek baat aur — tumhare ${k.moonNakshatra} nakshatra wale log..."
- Every 3rd message: ask one gentle follow-up question to deepen.`;
}

// ── Free teaser reading (no AI required as fallback) ─────────────────────────
// Format degrees as  15°23'
function fmtDeg(deg: number): string {
  const d = Math.floor(deg);
  const m = Math.round((deg - d) * 60);
  return `${String(d).padStart(2, "0")}°${String(m).padStart(2, "0")}'`;
}

// Planet symbols
const PLANET_SYMBOL: Record<string, string> = {
  Sun: "☀️", Moon: "🌙", Mars: "♂️", Mercury: "☿", Jupiter: "♃",
  Venus: "♀", Saturn: "♄", Rahu: "☊", Ketu: "☋",
};

// Short rashi names for table alignment
const RASHI_SHORT: string[] = [
  "Mesh", "Vrishabh", "Mithun", "Karka", "Simha", "Kanya",
  "Tula", "Vrischik", "Dhanu", "Makar", "Kumbh", "Meen",
];

function buildKundaliTable(user: UserRow): string {
  const k       = buildKundaliForUser(user);
  const name    = user.name ?? "ji";
  const lagnaRI = k.lagna?.rashiIndex ?? null;

  const order = ["Sun","Moon","Mars","Mercury","Jupiter","Venus","Saturn","Rahu","Ketu"];

  const tableRows = order.map(p => {
    const pl  = k.planets[p];
    const h   = lagnaRI !== null
      ? `H${String(((pl.rashiIndex - lagnaRI + 12) % 12) + 1).padStart(2,"0")}`
      : "H??";
    const deg = fmtDeg(pl.degInRashi);
    const rs  = RASHI_SHORT[pl.rashiIndex] ?? pl.rashi;
    // Dignity + retrograde markers (standard Vedic notation)
    const vakri = pl.retrograde ? "(R)" : "   ";
    const tag   = pl.dignity === "Exalted"     ? " Uchcha"
                : pl.dignity === "Debilitated" ? " Neech"
                : pl.dignity === "Own Sign"    ? " Swa"
                : "";
    return `${p.padEnd(9)} ${h}  ${deg} ${vakri} ${rs}${tag}`;
  }).join("\n");

  const lagnaLine = k.lagna
    ? `🌅 *Lagna:* ${k.lagna.rashi}  (${fmtDeg(k.lagna.degInRashi)})`
    : `🌅 *Lagna:* birth time chahiye — sahi house ke liye`;

  const sati = k.transits.sadeSati.isSadeSati
    ? `\n⚠️ *Sade Sati:* ${k.transits.sadeSati.phase} chal raha hai` : "";
  const yogaList = k.activeYogas.length
    ? `\n✨ *Yogas:* ${k.activeYogas.map(y => y.name).join(", ")}` : "";

  // Retrograde planets list for clarity
  const retrogradePlanets = order
    .filter(p => k.planets[p].retrograde && !["Rahu","Ketu"].includes(p))
    .join(", ");
  const retroNote = retrogradePlanets ? `\n🔄 *Vakri (Retrograde):* ${retrogradePlanets}` : "";

  return `🔮 *${name} ji ki Kundali* 🔮

${lagnaLine}
🌙 *Nakshatra:* ${k.moonNakshatra} Pada ${k.moonNakshatraPada}

\`\`\`
Graha     H    Deg    Vak  Rashi
───────────────────────────────────
${tableRows}
\`\`\`
_(R) = Vakri/Retrograde | Rahu-Ketu always (R)_

⏳ *Dasha:* ${k.currentDasha} → ${k.currentAntardasha}
📅 ${k.dashaBalance}${sati}${retroNote}${yogaList}

💪 Strong: ${k.strongestPlanets.slice(0,2).join(", ")}
⚠️ Weak: ${k.weakestPlanets.slice(0,2).join(", ")}

━━━━━━━━━━━━━━━━━━━━━━━━
🔒 _Premium mein: Pandit ji se seedha sawaal — 1 ghanta chat_`;
}

// ── Send paywall ──────────────────────────────────────────────────────────────
async function sendPayGate(chatId: number, reason: "trial_over" | "upgrade") {
  const msg = reason === "trial_over"
    ? `⏰ *1 minute ki jhalak khatam!*

Pandit ji abhi bhi tumhare saath hain — bas premium lo:

🔮 Full kundali analysis (saare yogas, transits, Sade Sati)
💬 *1 ghanta* Pandit ji se seedhi baat
🔁 3 alag-alag kundali analyze kar sakte ho (apni + 2 aur)
💎 Accurate predictions with specific timing
🙏 100% tumhare actual planets se — koi generic nahi`
    : `💎 *Full Premium Experience*

Pandit ji tumhare saath 1 ghanta:
🔮 Tumhari kundali ka deep analysis
💬 Koi bhi sawaal — career, love, paisa, health
🔁 3 kundali analyze karo (apni + 2 aur logon ki)
⏰ Specific timing predictions — month aur year ke saath
🙏 Purely tumhare actual planets se`;

  await bot.sendMessage(chatId, msg, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[
        { text: `⭐ ${PLANS.week.stars} Stars — 7 Din`, callback_data: "pay_week" },
        { text: `⭐ ${PLANS.month.stars} Stars — 1 Mahina 🔥`, callback_data: "pay_month" },
      ]],
    },
  });
}

async function sendInvoice(chatId: number, plan: PlanKey) {
  const p = PLANS[plan];
  await bot.sendInvoice(
    chatId,
    `🔮 AstroBot Premium — ${p.label}`,
    `Full Vedic Kundali analysis + 1 ghanta chat + 3 kundali in ${p.label}.`,
    `premium_${plan}`, "", "XTR",
    [{ label: `Premium ${p.label}`, amount: p.stars }]
  );
}

// ── Main menu ─────────────────────────────────────────────────────────────────
async function sendMainMenu(chatId: number, user: UserRow) {
  const name   = user.name ?? "friend";
  const isPaid = user.has_paid;
  const expiry = isPaid && user.premium_expires_at
    ? ` (${new Date(user.premium_expires_at).toLocaleDateString("en-IN")} tak)`
    : "";

  const keyboard = isPaid
    ? [
        [{ text: "🔮 Meri Kundali" }, { text: "💬 Pandit ji se Pooch" }],
        [{ text: "➕ Doosre ki Kundali" }, { text: "👤 Mera Profile" }],
      ]
    : [
        [{ text: "🔮 Free Preview" }],
        [{ text: "💬 Ek Sawaal Pandit ji se — Free" }],
        [{ text: "💎 Premium Lo" }, { text: "👤 Mera Profile" }],
      ];

  await bot.sendMessage(chatId,
    isPaid
      ? `🙏 Namaste *${name}* ji — Premium active${expiry}.\n\nKya dekhna hai aaj? Pandit ji ready hain! 🔮`
      : `🔮 Namaste *${name}* ji!\n\nAapki kundali ready hai. Free preview dekho ya Pandit ji se 1 minute seedha baat karo! 🙏`,
    { parse_mode: "Markdown", reply_markup: { keyboard, resize_keyboard: true } }
  );
}

// ── Start bot ─────────────────────────────────────────────────────────────────
export function startBot() {
  if (POLLING) {
    bot.startPolling({ restart: false });
    console.log("🤖 AstroBot polling started");
  }
  registerHandlers();
}

// ── Handlers ──────────────────────────────────────────────────────────────────
function registerHandlers() {

  // /start
  bot.onText(/\/start/, async (msg) => {
    const id   = msg.from!.id;
    const name = msg.from!.first_name ?? "friend";
    let user   = await upsertUser(id, name);

    if (!user.dob_year) {
      await pool.query(
        `UPDATE astro_users SET state='setup_name', name=NULL, dob_year=NULL,
         dob_month=NULL, dob_day=NULL, tob_hour=NULL, pob=NULL, lat=NULL, lon=NULL WHERE id=$1`, [id]
      );
      await bot.sendMessage(id,
        `🔮 *Namaste! Main hun AstroBot.*\n\nMain tumhari exact Vedic kundali banaunga — Keplerian astronomical calculations se, bilkul precise.\n\nShuru karte hain 🙏\n\n*Step 1/4 — Tumhara naam kya hai?*`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
    } else {
      user = await checkPremiumExpiry(user);
      await sendMainMenu(id, user);
    }
  });

  // /kundali
  bot.onText(/\/kundali/, async (msg) => {
    const id = msg.from!.id;
    let user = await getUser(id);
    if (!user?.dob_year) {
      await bot.sendMessage(id, "Pehle /start se apni birth details daalo! 🔮"); return;
    }
    user = await checkPremiumExpiry(user);
    await bot.sendMessage(id, buildKundaliTable(user), { parse_mode: "Markdown" });
    if (!user.has_paid) { await sendPayGate(id, "upgrade"); }
  });

  // Pre-checkout
  bot.on("pre_checkout_query", async (q) => {
    await bot.answerPreCheckoutQuery(q.id, true);
  });

  // Payment success
  bot.on("successful_payment", async (msg) => {
    const id      = msg.from!.id;
    const planKey = msg.successful_payment!.invoice_payload.replace("premium_", "") as PlanKey;
    const plan    = PLANS[planKey];
    if (!plan) return;
    const expiresAt = new Date(Date.now() + plan.days * 24 * 3600 * 1000);
    await pool.query(
      `UPDATE astro_users SET has_paid=true, premium_plan=$1, premium_expires_at=$2,
       premium_kundali_count=1, premium_chat_started_at=NULL, extra_kundalis='[]',
       chat_history='[]', updated_at=NOW() WHERE id=$3`,
      [planKey, expiresAt, id]
    );
    const user = await getUser(id);
    await bot.sendMessage(id,
      `🎉 *Premium active ho gaya!*\n\n✅ 1 ghante ki seedhi baat Pandit ji se\n✅ 3 kundali analyze karo (apni + 2 aur)\n✅ Full kundali — saare yogas, dashas, transits\n✅ ${plan.label} ke liye active\n\n*"Pandit ji se Pooch"* dabaao — shuru karte hain! 🙏🔮`,
      { parse_mode: "Markdown" }
    );
    if (user) await sendMainMenu(id, user);
  });

  // Callback (inline buttons)
  bot.on("callback_query", async (q) => {
    const id   = q.from.id;
    const data = q.data ?? "";
    await bot.answerCallbackQuery(q.id);
    if (data === "pay_week")  { await sendInvoice(id, "week");  return; }
    if (data === "pay_month") { await sendInvoice(id, "month"); return; }
  });

  // Main message handler
  bot.on("message", async (msg) => {
    if (!msg.text || msg.successful_payment) return;
    const id   = msg.from!.id;
    const name = msg.from!.first_name ?? "friend";
    const text = msg.text.trim();

    // ── Admin ───────────────────────────────────────────────────────────────
    if (id === ADMIN_ID) {

      // /users — stats
      if (text === "/users") {
        const s = await countUsers();
        await bot.sendMessage(id,
          `📊 *AstroBot Stats*\n\nTotal users: ${s.total}\nPaid: ${s.paid}\nJoined today: ${s.today}`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      // /listusers — recent 15 users with IDs
      if (text === "/listusers") {
        const users = await getRecentUsers(15);
        if (!users.length) { await bot.sendMessage(id, "No users yet."); return; }
        const lines = users.map((u, i) => {
          const status = u.has_paid ? `✅ ${u.premium_plan ?? "paid"}` : "🆓 free";
          const profile = u.dob_year ? `📍 ${u.pob ?? "?"}` : "⚠️ no profile";
          const displayName = u.name ?? u.first_name ?? "Unknown";
          return `${i + 1}. *${displayName}* — \`${u.id}\`\n   ${status} | ${profile}`;
        });
        await bot.sendMessage(id,
          `👥 *Recent Users (newest first)*\n\n${lines.join("\n\n")}`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      // /getuser <id> — full profile lookup
      if (text.startsWith("/getuser ")) {
        const uid = Number(text.split(" ")[1]);
        if (isNaN(uid)) { await bot.sendMessage(id, "Usage: /getuser <telegram_id>"); return; }
        const u = await getUserById(uid);
        if (!u) { await bot.sendMessage(id, `❌ User ${uid} not found.`); return; }
        const expiry = u.premium_expires_at
          ? new Date(u.premium_expires_at).toLocaleDateString("en-IN") : "—";
        const dob = u.dob_year ? `${u.dob_day}/${u.dob_month}/${u.dob_year}` : "Not set";
        await bot.sendMessage(id,
          `👤 *User Profile*\n\n` +
          `ID: \`${u.id}\`\n` +
          `Name: ${u.name ?? u.first_name ?? "?"}\n` +
          `DOB: ${dob}\n` +
          `TOB: ${u.tob_hour != null ? `${Math.floor(u.tob_hour)}:${String(Math.round((u.tob_hour % 1) * 60)).padStart(2,"0")}` : "Not given"}\n` +
          `POB: ${u.pob ?? "Not set"}\n` +
          `Status: ${u.has_paid ? `✅ Premium (${u.premium_plan}) until ${expiry}` : "🆓 Free"}\n` +
          `State: ${u.state}\n` +
          `Kundalis: ${u.premium_kundali_count}/${MAX_KUNDALI_COUNT}`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      // /grantpremium <id> [week|month|year] — grant premium to ANY Telegram user ID
      // Works even if the user has never started the bot (creates a record for them)
      if (text.startsWith("/grantpremium ")) {
        const parts = text.split(" ");
        const uid   = Number(parts[1]);
        const plan  = (["week","month","year"].includes(parts[2] ?? "") ? parts[2] : "month") as "week" | "month" | "year";
        const days  = plan === "week" ? 7 : plan === "year" ? 365 : 30;
        if (!uid || isNaN(uid)) {
          await bot.sendMessage(id,
            `❌ *Usage:* \`/grantpremium <telegram_id> [week|month|year]\`\n\n` +
            `Examples:\n` +
            `• \`/grantpremium 987654321\` — 1 month (default)\n` +
            `• \`/grantpremium 987654321 week\` — 7 days\n` +
            `• \`/grantpremium 987654321 year\` — 1 year\n\n` +
            `_User does NOT need to have started the bot._`,
            { parse_mode: "Markdown" }
          );
          return;
        }
        try {
          const result = await grantPremiumById(uid, plan, days);
          const displayName = result.name ?? String(uid);
          const statusNote = result.created
            ? `_(New record created — user hasn't started bot yet)_`
            : `_(Existing user updated)_`;
          // Notify the user (will fail silently if they haven't started the bot)
          try {
            await bot.sendMessage(uid,
              `🎉 *Aapko Premium Access mil gaya!*\n\nPandit Ramesh Shastri ji ne aapko *${days} din* ka premium grant kiya hai.\n\n` +
              `✅ *1 ghanta* Pandit ji se seedhi baat\n` +
              `✅ *3 kundali* analyze kar sakte ho\n` +
              `✅ Detailed predictions aur remedies\n\n` +
              `Bot mein jaake /start karo aur "Pandit ji se Pooch" dabaao! 🙏`,
              { parse_mode: "Markdown" }
            );
          } catch { /* user hasn't started bot or has blocked — silent */ }
          await bot.sendMessage(id,
            `✅ *Premium granted!*\n\n` +
            `👤 User: \`${uid}\` (${displayName})\n` +
            `📅 Plan: ${plan} — *${days} days*\n` +
            `⏰ Expires: ${new Date(Date.now() + days * 864e5).toLocaleDateString("en-IN")}\n` +
            `${statusNote}`,
            { parse_mode: "Markdown" }
          );
        } catch (err) {
          await bot.sendMessage(id, `❌ Error: ${String(err).slice(0,100)}`);
        }
        return;
      }

      // /deleteuser <id> — permanently remove a user from the database
      if (text.startsWith("/deleteuser ")) {
        const uid = Number(text.split(" ")[1]);
        if (!uid || isNaN(uid)) {
          await bot.sendMessage(id,
            `❌ *Usage:* \`/deleteuser <telegram_id>\`\n\nExample: \`/deleteuser 987654321\`\n\n⚠️ This permanently deletes all user data (kundali, chat history, payment status).`,
            { parse_mode: "Markdown" }
          );
          return;
        }
        if (uid === ADMIN_ID) {
          await bot.sendMessage(id, `⛔ Admin account cannot be deleted.`);
          return;
        }
        try {
          const result = await deleteUser(uid);
          if (!result.found) {
            await bot.sendMessage(id, `❌ User \`${uid}\` not found in database.`, { parse_mode: "Markdown" });
          } else {
            const displayName = result.name ?? "Unknown";
            const paidNote = result.wasPaid ? `\n💳 _This user had active premium — it has been removed._` : "";
            await bot.sendMessage(id,
              `🗑️ *User deleted successfully*\n\n` +
              `👤 ID: \`${uid}\`\n` +
              `📛 Name: ${displayName}\n` +
              `📊 All data removed: profile, kundali, chat history, payment status` +
              `${paidNote}`,
              { parse_mode: "Markdown" }
            );
          }
        } catch (err) {
          await bot.sendMessage(id, `❌ Delete failed: ${String(err).slice(0,100)}`);
        }
        return;
      }

      // /revokepremium <id>
      if (text.startsWith("/revokepremium ")) {
        const uid = Number(text.split(" ")[1]);
        if (!uid || isNaN(uid)) {
          await bot.sendMessage(id, `❌ *Usage:* \`/revokepremium <telegram_id>\``, { parse_mode: "Markdown" });
          return;
        }
        const target = await getUserById(uid);
        if (!target) {
          await bot.sendMessage(id, `❌ User \`${uid}\` not found.`, { parse_mode: "Markdown" });
          return;
        }
        await pool.query(
          `UPDATE astro_users SET has_paid=false, premium_plan=NULL, premium_expires_at=NULL,
           premium_chat_started_at=NULL, premium_kundali_count=0 WHERE id=$1`, [uid]
        );
        const dName = target.name ?? target.first_name ?? String(uid);
        await bot.sendMessage(id, `✅ Premium revoked for *${dName}* (\`${uid}\`)`, { parse_mode: "Markdown" });
        return;
      }

      // /adminhelp
      if (text === "/adminhelp") {
        await bot.sendMessage(id,
          `🛠️ *Admin Commands — AstroVedic Bot*\n\n` +
          `📊 *Stats & Users*\n` +
          `/users — total stats (total, paid, today)\n` +
          `/listusers — last 15 users with IDs\n` +
          `/getuser <id> — full user profile\n\n` +
          `💎 *Premium Management*\n` +
          `/grantpremium <id> [week|month|year] — grant premium to ANY user by Telegram ID (creates record if needed, default: month)\n` +
          `/revokepremium <id> — remove premium from user\n\n` +
          `🗑️ *User Management*\n` +
          `/deleteuser <id> — permanently delete all user data\n\n` +
          `📡 *Broadcast*\n` +
          `/broadcast — send promo to all free users with profiles\n\n` +
          `_Tip: Use /listusers to find IDs, /getuser to verify before granting/deleting_`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      if (text === "/broadcast") {
        const users = await getUnpaidActiveUsers();
        await bot.sendMessage(id, `📡 Broadcasting to ${users.length} users...`);
        const msgs = [
          `🔮 *Ek minute ki free baat — Pandit Ramesh Shastri ji se*\n\nTumhari kundali mein kuch khaas planetary combinations hain.\nSirf 1 minute mein sunlo — kya chal raha hai tumhari life mein abhi.\n\n*/start* type karo ya neeche button dabaao 👇`,
          `🪐 *Sade Sati check karo — free mein*\n\nSaturn ka transit tumhare Moon se kitna dur hai? Yeh sab pata chalta hai tumhari kundali mein.\n\nAaj 1 minute free mein Pandit ji se poochho 🙏\n*/start*`,
          `🌙 *Tumhare ${new Date().getFullYear()} ke liye kya hai kundali mein?*\n\nCareer shift? Relationship clarity? Financial breakthrough?\n\nPandit Ramesh Shastri ji 1 minute free mein tumhare actual planets se batayenge.\n*/start* 🔮`,
        ];
        let sent = 0;
        for (const u of users) {
          try {
            await bot.sendMessage(u.id, msgs[Math.floor(Math.random() * msgs.length)], {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[
                { text: `⭐ ${PLANS.week.stars} Stars — 7 Din`, callback_data: "pay_week" },
                { text: `⭐ ${PLANS.month.stars} Stars — 1 Mahina 🔥`, callback_data: "pay_month" },
              ]] },
            });
            sent++;
          } catch { /* blocked */ }
          await delay(80);
        }
        await bot.sendMessage(id, `✅ Done! Sent: ${sent}/${users.length}`);
        return;
      }
    }

    // ── Get user ────────────────────────────────────────────────────────────
    let user = await getUser(id);
    if (!user) { await upsertUser(id, name); user = await getUser(id); }
    if (!user) return;
    user = await checkPremiumExpiry(user);

    // ── SETUP: Name ─────────────────────────────────────────────────────────
    if (user.state === "setup_name") {
      if (text.startsWith("/")) return;
      if (text.length < 2 || text.length > 40) {
        await bot.sendMessage(id, "Bas apna pehla naam likhna hai 🙏"); return;
      }
      await upsertUser(id, name, { name: text, state: "setup_dob" });
      await bot.sendMessage(id,
        `Namaste *${text}* ji! 🙏\n\n*Step 2/4* — *Janm tithi* batao:\n\nFormat: DD/MM/YYYY\nJaise: 15/03/1995`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
      return;
    }

    // ── SETUP: DOB ──────────────────────────────────────────────────────────
    if (user.state === "setup_dob") {
      const parts = text.split("/");
      if (parts.length !== 3) { await bot.sendMessage(id, "Format: DD/MM/YYYY — jaise 15/03/1995"); return; }
      const [d, m, y] = parts.map(Number);
      if (!d || !m || !y || d < 1 || d > 31 || m < 1 || m > 12 || y < 1900 || y > new Date().getFullYear() || isNaN(d + m + y)) {
        await bot.sendMessage(id, "Sahi date daalo — jaise 15/03/1995"); return;
      }
      await upsertUser(id, name, { dob_day: d, dob_month: m, dob_year: y, state: "setup_tob" });
      await bot.sendMessage(id,
        `✅ DOB save!\n\n*Step 3/4* — *Janm samay* batao:\n\nFormat: HH:MM — jaise 10:30 ya 22:45\n_(Pata na ho toh Skip karo — Lagna thoda alag hoga, baaki sab sahi)_`,
        {
          parse_mode: "Markdown",
          reply_markup: { keyboard: [[{ text: "⏭️ Skip" }]], resize_keyboard: true, one_time_keyboard: true },
        }
      );
      return;
    }

    // ── SETUP: TOB ──────────────────────────────────────────────────────────
    if (user.state === "setup_tob") {
      let tobHour: number | null = null;
      if (text !== "⏭️ Skip") {
        const match = text.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
          await bot.sendMessage(id, "Format HH:MM — jaise 10:30 ya 22:45",
            { reply_markup: { keyboard: [[{ text: "⏭️ Skip" }]], resize_keyboard: true, one_time_keyboard: true } });
          return;
        }
        const [, h, mi] = match.map(Number);
        if (h > 23 || mi > 59) { await bot.sendMessage(id, "Sahi time: 00:00 se 23:59"); return; }
        tobHour = h + mi / 60;
      }
      await upsertUser(id, name, { tob_hour: tobHour, state: "setup_pob" });
      await bot.sendMessage(id,
        `✅ Time save!\n\n*Step 4/4* — *Janm sthan* batao:\n\nCity ka naam — jaise: Mumbai, Delhi, Jaipur`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
      return;
    }

    // ── SETUP: POB ──────────────────────────────────────────────────────────
    if (user.state === "setup_pob") {
      if (text.length < 2) { await bot.sendMessage(id, "City ka naam batao — jaise Delhi"); return; }
      await bot.sendMessage(id, `🌍 *"${text}"* dhundh raha hun...`, { parse_mode: "Markdown" });
      const geo = await geocode(text);
      if (!geo) {
        await bot.sendMessage(id, `❌ *"${text}"* nahi mila.\n\nClearly likho — jaise "Lucknow, India"`, { parse_mode: "Markdown" });
        return;
      }
      await upsertUser(id, name, { pob: geo.display, lat: geo.lat, lon: geo.lon, tz_offset_hours: geo.tzOffset, state: "idle" });
      const freshUser = await getUser(id);
      await bot.sendMessage(id, `✅ *${geo.display}* — 🔮 Kundali ban rahi hai...`, { parse_mode: "Markdown" });
      await delay(1000);
      await bot.sendMessage(id, buildKundaliTable(freshUser!), { parse_mode: "Markdown" });
      await delay(600);
      await sendPayGate(freshUser!, "upgrade");
      await sendMainMenu(id, freshUser!);
      return;
    }

    // ── ADD EXTRA KUNDALI — state machine ───────────────────────────────────
    if (user.state === "ek_name") {
      if (text.length < 2) { await bot.sendMessage(id, "Naam batao (2+ letters)"); return; }
      await pool.query(`UPDATE astro_users SET state='ek_dob', chat_history=chat_history||$1::jsonb WHERE id=$2`,
        [JSON.stringify([{ role: "_ek_name", content: text }]), id]);
      await bot.sendMessage(id, `*${text}* ka naam save!\n\nUnki *janm tithi* batao: DD/MM/YYYY`, { parse_mode: "Markdown" });
      return;
    }

    if (user.state === "ek_dob") {
      const parts = text.split("/");
      if (parts.length !== 3) { await bot.sendMessage(id, "Format: DD/MM/YYYY"); return; }
      const [d, m, y] = parts.map(Number);
      if (!d || !m || !y || d < 1 || d > 31 || m < 1 || m > 12 || y < 1900 || isNaN(d + m + y)) {
        await bot.sendMessage(id, "Sahi date daalo"); return;
      }
      await pool.query(`UPDATE astro_users SET state='ek_tob', chat_history=chat_history||$1::jsonb WHERE id=$2`,
        [JSON.stringify([{ role: "_ek_dob", content: `${d}/${m}/${y}` }]), id]);
      await bot.sendMessage(id, `✅ DOB save!\n\n*Janm samay* batao (HH:MM) ya Skip karo:`,
        { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "⏭️ Skip" }]], resize_keyboard: true, one_time_keyboard: true } });
      return;
    }

    if (user.state === "ek_tob") {
      let tobStr = "null";
      if (text !== "⏭️ Skip") {
        const match = text.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
          await bot.sendMessage(id, "Format HH:MM ya Skip",
            { reply_markup: { keyboard: [[{ text: "⏭️ Skip" }]], resize_keyboard: true, one_time_keyboard: true } });
          return;
        }
        const [, h, mi] = match.map(Number);
        tobStr = String(h + mi / 60);
      }
      await pool.query(`UPDATE astro_users SET state='ek_pob', chat_history=chat_history||$1::jsonb WHERE id=$2`,
        [JSON.stringify([{ role: "_ek_tob", content: tobStr }]), id]);
      await bot.sendMessage(id, `*Janm sthan* batao (city):`, { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } });
      return;
    }

    if (user.state === "ek_pob") {
      if (text.length < 2) { await bot.sendMessage(id, "City ka naam batao"); return; }
      await bot.sendMessage(id, `🌍 *"${text}"* dhundh raha hun...`, { parse_mode: "Markdown" });
      const geo = await geocode(text);
      if (!geo) {
        await bot.sendMessage(id, `❌ "${text}" nahi mila. Clearly likho — jaise "Delhi, India"`); return;
      }
      // Extract from temp chat_history slots
      const freshUser = await getUser(id);
      const hist = freshUser?.chat_history ?? [];
      const nameEntry = [...hist].reverse().find(h => h.role === "_ek_name");
      const dobEntry  = [...hist].reverse().find(h => h.role === "_ek_dob");
      const tobEntry  = [...hist].reverse().find(h => h.role === "_ek_tob");
      if (!nameEntry || !dobEntry) {
        await bot.sendMessage(id, "Kuch galat ho gaya. Dobara try karo."); 
        await upsertUser(id, name, { state: "chatting" });
        return;
      }
      const [d, m, y] = dobEntry.content.split("/").map(Number);
      const ek: ExtraKundali = {
        name:            nameEntry.content,
        dob_day:         d, dob_month: m, dob_year: y,
        tob_hour:        tobEntry?.content === "null" || !tobEntry ? null : Number(tobEntry.content),
        tz_offset_hours: geo.tzOffset,
        pob:             geo.display,
        lat:             geo.lat,
        lon:             geo.lon,
      };
      await addExtraKundali(id, ek);
      // Clean temp entries
      await pool.query(
        `UPDATE astro_users SET state='chatting',
         chat_history = (SELECT jsonb_agg(elem) FROM jsonb_array_elements(chat_history) elem WHERE elem->>'role' NOT LIKE '_ek_%'),
         updated_at=NOW() WHERE id=$1`, [id]
      );
      await bot.sendMessage(id,
        `✅ *${ek.name}* ki kundali add ho gayi!\n\nAb Pandit ji unke baare mein bhi bata sakte hain 🙏`,
        { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "🔙 Menu" }]], resize_keyboard: true } }
      );
      return;
    }

    // ── CHATTING ─────────────────────────────────────────────────────────────
    if (user.state === "chatting") {
      if (text === "🔙 Menu") {
        await upsertUser(id, name, { state: "idle" });
        await clearChatHistory(id);
        await sendMainMenu(id, user);
        return;
      }

      // Free user: check if they have already gotten their 1 free answer
      if (!user.has_paid) {
        const prevUserMsgs = (user.chat_history ?? []).filter(h => h.role === "user").length;
        if (prevUserMsgs >= 1) {
          // Already used their one free question
          await upsertUser(id, name, { state: "idle" });
          await clearChatHistory(id);
          await bot.sendMessage(id,
            `🔒 *Ek sawaal ka free jawab ho gaya!*\n\nPandit ji se aur baat karni hai? Premium lo — 1 ghanta, unlimited sawaal, 3 kundali 🙏`,
            { parse_mode: "Markdown" }
          );
          await sendPayGate(id, "trial_over");
          await sendMainMenu(id, user);
          return;
        }
      }

      // Check 1-hour premium chat expiry
      if (user.has_paid && user.premium_chat_started_at) {
        const elapsed = Date.now() - new Date(user.premium_chat_started_at).getTime();
        if (elapsed > PREMIUM_CHAT_MS) {
          await upsertUser(id, name, { state: "idle" });
          await clearChatHistory(id);
          await pool.query(`UPDATE astro_users SET premium_chat_started_at=NULL WHERE id=$1`, [id]);
          await bot.sendMessage(id,
            `🕐 *1 ghante ki premium chat khatam ho gayi!*\n\nPandit ji se bahut acha conversation raha 🙏\n\nAgle session ke liye phir premium lo — tumhari kundali mein abhi bhi bahut kuch baaki hai.`,
            { parse_mode: "Markdown" }
          );
          await sendMainMenu(id, user);
          return;
        }
      }

      // AI reply
      await addChatMessage(id, "user", text);
      const freshUser = await getUser(id);
      const history   = (freshUser?.chat_history ?? [])
        .filter(h => h.role === "user" || h.role === "assistant")
        .slice(-12);
      const sysPrompt = buildSystemPrompt(freshUser ?? user);

      const isFree = !user.has_paid;

      // Free users get a super-detailed system prompt addon to encourage exhaustive answer
      const freeAddon = isFree
        ? `\n\n⚡ SPECIAL INSTRUCTION — FREE TRIAL ANSWER:
This is the user's ONE FREE QUESTION. Give your MOST COMPREHENSIVE, DETAILED reading possible.
Structure your answer in clear sections:
1. What the planets say about this topic (name 3-4 planets with house+rashi)
2. Current dasha impact on this topic (what ${freshUser?.chat_history?.[0]?.content ? "this area" : "their question"} looks like in ${freshUser?.chat_history?.[0]?.content ?? "this"} dasha)
3. Specific timing — give 2-3 actual time windows in the next 18 months
4. One powerful remedy tailored to their weakest planet
5. A closing statement that leaves them wanting more (but don't be manipulative — be genuinely insightful)
Write 350-450 words. This is your showcase reading — make it UNFORGETTABLE.`
        : "";

      bot.sendChatAction(id, "typing").catch(() => {});
      try {
        await delay(1200 + Math.random() * 800);
        const reply = await groqChat(
          [{ role: "system", content: sysPrompt + freeAddon }, ...history],
          isFree ? 900 : 500,
          isFree ? 0.75 : 0.72
        );
        await addChatMessage(id, "assistant", reply);

        // Split long replies into bubbles
        const bubbles = reply.length > 900
          ? reply.split(/\n{2,}/).reduce<string[]>((acc, p) => {
              const last = acc[acc.length - 1] ?? "";
              if (last.length + p.length < 800) {
                acc[acc.length - 1] = last ? last + "\n\n" + p : p;
              } else { acc.push(p); }
              return acc;
            }, [""])
          : [reply];

        for (let i = 0; i < bubbles.length; i++) {
          if (!bubbles[i].trim()) continue;
          if (i > 0) { bot.sendChatAction(id, "typing").catch(() => {}); await delay(600 + bubbles[i].length * 8); }
          await bot.sendMessage(id, bubbles[i], {
            reply_markup: { keyboard: [[{ text: "🔙 Menu" }]], resize_keyboard: true },
          });
        }

        // Free user: after sending the one detailed answer, show paywall
        if (isFree) {
          await delay(1000);
          await upsertUser(id, name, { state: "idle" });
          await bot.sendMessage(id,
            `✨ *Kaisa laga Pandit ji ka jawab?*\n\nYeh sirf ek jhalak thi — tumhari kundali mein abhi bahut kuch aur chhupa hai.\n\nPremium mein milega: *1 ghanta* Pandit ji se seedhi baat, saare yogas, timing predictions, aur 3 kundali analysis 🔮`,
            { parse_mode: "Markdown" }
          );
          await sendPayGate(id, "trial_over");
          const refreshed = await getUser(id);
          if (refreshed) await sendMainMenu(id, refreshed);
        }
      } catch (err) {
        console.error("Groq final error:", String(err).slice(0, 200));
        // AI failed — give a full static reading from kundali data instead
        const staticReply = generateStaticReading(freshUser ?? user, text);
        await addChatMessage(id, "assistant", staticReply);

        const bubbles = staticReply.split(/\n{2,}/).reduce<string[]>((acc, p) => {
          const last = acc[acc.length - 1] ?? "";
          if (last.length + p.length < 800) {
            acc[acc.length - 1] = last ? last + "\n\n" + p : p;
          } else { acc.push(p); }
          return acc;
        }, [""]);

        for (let i = 0; i < bubbles.length; i++) {
          if (!bubbles[i].trim()) continue;
          if (i > 0) { bot.sendChatAction(id, "typing").catch(() => {}); await delay(700); }
          await bot.sendMessage(id, bubbles[i], {
            parse_mode: "Markdown",
            reply_markup: { keyboard: [[{ text: "🔙 Menu" }]], resize_keyboard: true },
          });
        }

        // Still show paywall for free users after static reading
        if (isFree) {
          await delay(1000);
          await upsertUser(id, name, { state: "idle" });
          await bot.sendMessage(id,
            `✨ *Kaisa laga Pandit ji ka jawab?*\n\nYeh sirf ek jhalak thi — tumhari kundali mein abhi bahut kuch aur chhupa hai.\n\nPremium mein milega: *1 ghanta* Pandit ji se seedhi baat, saare yogas, timing predictions, aur 3 kundali analysis 🔮`,
            { parse_mode: "Markdown" }
          );
          await sendPayGate(id, "trial_over");
          const refreshed = await getUser(id);
          if (refreshed) await sendMainMenu(id, refreshed);
        }
      }
      return;
    }

    // ── Menu buttons ─────────────────────────────────────────────────────────

    if (text === "🔮 Free Preview" || text === "🔮 Meri Kundali") {
      if (!user.dob_year) { await bot.sendMessage(id, "Pehle /start se profile banao!"); return; }
      await bot.sendMessage(id, buildKundaliTable(user), { parse_mode: "Markdown" });
      if (!user.has_paid) { await delay(400); await sendPayGate(id, "upgrade"); }
      return;
    }

    if (text === "💬 Ek Sawaal Pandit ji se — Free" || text === "💬 Pandit ji se Pooch") {
      if (!user.dob_year) { await bot.sendMessage(id, "Pehle /start se profile banao!"); return; }

      if (user.has_paid) {
        // Start/resume premium chat
        if (!user.premium_chat_started_at) {
          await pool.query(
            `UPDATE astro_users SET premium_chat_started_at=NOW(), state='chatting', chat_history='[]' WHERE id=$1`, [id]
          );
        } else {
          await upsertUser(id, name, { state: "chatting" });
        }
        const freshUser = await getUser(id);
        const timeUsedMs = user.premium_chat_started_at
          ? Date.now() - new Date(user.premium_chat_started_at).getTime() : 0;
        const minsLeft = Math.max(0, Math.round((PREMIUM_CHAT_MS - timeUsedMs) / 60000));
        const k = buildKundaliForUser(freshUser!);

        await bot.sendMessage(id,
          `🔮 *Pandit ji available hain!* _(${minsLeft} min bacha hai session mein)_\n\nPooch lo — kuch bhi 🙏`,
          { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "🔙 Menu" }]], resize_keyboard: true } }
        );

        // Send personalized opening with nakshatra data
        await delay(1500);
        bot.sendChatAction(id, "typing").catch(() => {});
        const opening = await groqChat([{ role: "user", content: `You are Pandit Ramesh Shastri. Generate a 3-4 sentence warm opening greeting for ${user.name ?? "beta"} who has come back for a consultation. Their Moon is in ${k.moonNakshatra} nakshatra (${k.nakshatraTraits.nature.slice(0,60)}). Current dasha: ${k.currentDasha}-${k.currentAntardasha}. ${k.transits.sadeSati.isSadeSati ? "They ARE in Sade Sati — acknowledge with compassion." : ""} Write in warm Hinglish. Be specific to their nakshatra. Make it feel like you KNOW them.` }], 150, 0.8).catch(() => `Aao ${user.name ?? "beta"} ji... 🙏 Tumhari kundali dekh raha hun. ${k.moonNakshatra} nakshatra waale log bahut kuch andar rakhte hain. Pooch lo — kuch bhi.`);
        await bot.sendMessage(id, opening, { reply_markup: { keyboard: [[{ text: "🔙 Menu" }]], resize_keyboard: true } });

      } else {
        // Free trial — 1 question, exhaustive answer, then paywall
        await pool.query(`UPDATE astro_users SET trial_started_at=NOW(), state='chatting', chat_history='[]' WHERE id=$1`, [id]);
        const freshUser = await getUser(id);
        const k = buildKundaliForUser(freshUser!);

        // Opening WOW message first
        await delay(800);
        bot.sendChatAction(id, "typing").catch(() => {});
        const opening = await groqChat([{ role: "user", content: `You are Pandit Ramesh Shastri meeting ${user.name ?? "beta"} for the FIRST TIME. Write a 4-5 sentence opening message that feels eerily accurate. Their Moon is in ${k.moonNakshatra} nakshatra. Core trait: "${k.nakshatraTraits.nature.slice(0,80)}". Shadow: "${k.nakshatraTraits.shadow}". Dasha: ${k.currentDasha}-${k.currentAntardasha}. Strongest planet: ${k.strongestPlanets[0]}. ${k.transits.sadeSati.isSadeSati ? "They are in Sade Sati." : ""} Start with "Aao beta..." or "Baitho...". Say something specific about their inner world they have NEVER been told. End with: "Ek sawaal pooch lo — main tumhari kundali se seedha jawab dunga 🙏". Warm Hinglish.` }], 180, 0.85).catch(() => `Aao ${user.name ?? "beta"} ji... 🙏\n\nTumhara ${k.moonNakshatra} nakshatra bahut kuch keh raha hai — andar se tumhara mann zyada feel karta hai jo bahar nahi aata. Abhi ${k.currentDasha} dasha chal raha hai.\n\nEk sawaal pooch lo — main tumhari kundali se seedha jawab dunga 🙏`);
        await bot.sendMessage(id, opening, {
          parse_mode: "Markdown",
          reply_markup: { keyboard: [[{ text: "🔙 Menu" }]], resize_keyboard: true },
        });
      }
      return;
    }

    // ── Add extra kundali ───────────────────────────────────────────────────
    if (text === "➕ Doosre ki Kundali") {
      if (!user.has_paid) { await sendPayGate(id, "upgrade"); return; }
      const count = user.premium_kundali_count;
      if (count >= MAX_KUNDALI_COUNT) {
        await bot.sendMessage(id,
          `🔮 Is session mein tumne pehle se *${MAX_KUNDALI_COUNT} kundali* analyze kar li hain!\n\nNext purchase ke baad naya session milega.`,
          { parse_mode: "Markdown" }
        );
        return;
      }
      const remaining = MAX_KUNDALI_COUNT - count;
      await upsertUser(id, name, { state: "ek_name" });
      await bot.sendMessage(id,
        `➕ *Doosri kundali add karo* (${remaining} bacha hai)\n\nJis insaan ki kundali dekhni hai, unka *naam* batao:`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
      return;
    }

    // ── Profile ─────────────────────────────────────────────────────────────
    if (text === "👤 Mera Profile") {
      const dob = user.dob_year ? `${user.dob_day}/${user.dob_month}/${user.dob_year}` : "Not set";
      const tob = user.tob_hour != null
        ? `${String(Math.floor(user.tob_hour)).padStart(2,"0")}:${String(Math.round((user.tob_hour % 1) * 60)).padStart(2,"0")}`
        : "Not provided";
      const status = user.has_paid
        ? `✅ Premium${user.premium_expires_at ? ` — ${new Date(user.premium_expires_at).toLocaleDateString("en-IN")} tak` : ""}`
        : "🔒 Free";
      const extra = user.extra_kundalis?.length > 0
        ? `\n👥 Extra kundalis: ${user.extra_kundalis.map(e => e.name).join(", ")}` : "";
      await bot.sendMessage(id,
        `👤 *Profile*\n\n📛 ${user.name ?? "Not set"}\n📅 DOB: ${dob}\n⏰ TOB: ${tob}\n📍 POB: ${user.pob ?? "Not set"}\n⭐ ${status}${extra}`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ── Premium Lo ──────────────────────────────────────────────────────────
    if (text === "💎 Premium Lo") {
      await sendPayGate(id, "upgrade"); return;
    }

    // ── Fallback ────────────────────────────────────────────────────────────
    if (user.dob_year) { await sendMainMenu(id, user); }
    else { await bot.sendMessage(id, "/start se profile banao! 🔮"); }
  });
}

// Silence unhandled rejections (polling errors etc.)
process.on("unhandledRejection", (reason) => {
  const msg = String(reason instanceof Error ? reason.message : reason);
  if (msg.includes("409") || msg.includes("ETELEGRAM")) return;
  console.error("Unhandled rejection:", msg.slice(0, 200));
});

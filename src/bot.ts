import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import {
  getUser, upsertUser, checkPremiumExpiry, pool,
  addChatMessage, clearChatHistory, addExtraKundali,
  countUsers, getUnpaidActiveUsers, ExtraKundali,
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

const FREE_TRIAL_MS      = 60  * 1000;        // 1 minute free trial
const PREMIUM_CHAT_MS    = 60  * 60 * 1000;   // 1 hour premium chat window
const MAX_KUNDALI_COUNT  = 3;                  // max 3 kundalis per premium session

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const trialTimers = new Map<number, NodeJS.Timeout>();

// ── Groq AI ───────────────────────────────────────────────────────────────────
async function groqChat(
  messages: { role: string; content: string }[],
  maxTokens = 500,
  temperature = 0.72
): Promise<string> {
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
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json() as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json.choices?.[0]?.message?.content?.trim() ?? "";
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
function staticTeaser(user: UserRow): string {
  const k    = buildKundaliForUser(user);
  const name = user.name ?? "ji";
  const sati = k.transits.sadeSati.isSadeSati
    ? `\n⚠️ *Sade Sati chal raha hai* — yeh period important hai, sambhal ke chalo.` : "";
  const yoga = k.activeYogas[0]
    ? `\n✨ *${k.activeYogas[0].name}* tumhare chart mein hai — yeh bahut acha sign hai!` : "";
  return `🌟 *${name} ji ki Kundali — Free Preview* 🌟

☀️ *Sun:* ${k.planets.Sun.rashi} — ${k.planets.Sun.dignity}
🌙 *Moon:* ${k.planets.Moon.rashi} | *Nakshatra:* ${k.moonNakshatra} Pada ${k.moonNakshatraPada}
${k.lagna ? `🌅 *Lagna:* ${k.lagna.rashi}` : `🌅 Lagna: (birth time chahiye)`}

⏰ *Abhi chal raha hai:* ${k.currentDasha} Mahadasha → ${k.currentAntardasha} Antardasha
📅 *${k.dashaBalance}*
${sati}${yoga}

💪 *Strongest planet:* ${k.strongestPlanets[0]}
⚠️ *Needs attention:* ${k.weakestPlanets[0]}

━━━━━━━━━━━━━━━━━━━━━━━━
🔒 _Premium mein: deep analysis, accurate predictions with timing, all yogas, Sade Sati, and Pandit ji se 1 ghante ki seedhi baat_`;
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
        [{ text: "💬 Pandit ji se Pooch (1 min Free)" }],
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
    await bot.sendMessage(id, staticTeaser(user), { parse_mode: "Markdown" });
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
      if (text === "/users") {
        const s = await countUsers();
        await bot.sendMessage(id,
          `📊 *AstroBot Stats*\n\nTotal: ${s.total}\nPaid: ${s.paid}\nToday: ${s.today}`,
          { parse_mode: "Markdown" }
        );
        return;
      }
      if (text.startsWith("/grantpremium ")) {
        const uid = Number(text.split(" ")[1]);
        if (!isNaN(uid)) {
          await pool.query(
            `UPDATE astro_users SET has_paid=true, premium_plan='month',
             premium_expires_at=NOW()+INTERVAL'30 days', premium_kundali_count=1 WHERE id=$1`, [uid]
          );
          await bot.sendMessage(id, `✅ Premium granted to ${uid}`);
        }
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
      await bot.sendMessage(id, staticTeaser(freshUser!), { parse_mode: "Markdown" });
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
        const t = trialTimers.get(id); if (t) { clearTimeout(t); trialTimers.delete(id); }
        await upsertUser(id, name, { state: "idle" });
        await clearChatHistory(id);
        await sendMainMenu(id, user);
        return;
      }

      // Check 1-minute free trial expiry
      if (!user.has_paid && user.trial_started_at) {
        const elapsed = Date.now() - new Date(user.trial_started_at).getTime();
        if (elapsed > FREE_TRIAL_MS) {
          const t = trialTimers.get(id); if (t) { clearTimeout(t); trialTimers.delete(id); }
          await upsertUser(id, name, { state: "idle" });
          await clearChatHistory(id);
          await bot.sendMessage(id,
            `⏰ *1 minute khatam ho gayi!*\n\nPandit ji ka jawab sun ke kaisa laga? Aur bhi bahut kuch hai tumhari kundali mein... 🔮`,
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

      bot.sendChatAction(id, "typing").catch(() => {});
      try {
        await delay(1200 + Math.random() * 1000);
        const reply = await groqChat(
          [{ role: "system", content: sysPrompt }, ...history],
          500, 0.72
        );
        await addChatMessage(id, "assistant", reply);

        // Split into bubbles if reply is long
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
          if (i > 0) { bot.sendChatAction(id, "typing").catch(() => {}); await delay(700 + bubbles[i].length * 10); }
          await bot.sendMessage(id, bubbles[i], {
            reply_markup: { keyboard: [[{ text: "🔙 Menu" }]], resize_keyboard: true },
          });
        }
      } catch (err) {
        console.error("Groq error:", err);
        await bot.sendMessage(id,
          "🙏 Thodi der ke liye connection slow ho gaya. Dobara bhejo apna sawaal.",
          { reply_markup: { keyboard: [[{ text: "🔙 Menu" }]], resize_keyboard: true } }
        );
      }
      return;
    }

    // ── Menu buttons ─────────────────────────────────────────────────────────

    if (text === "🔮 Free Preview" || text === "🔮 Meri Kundali") {
      if (!user.dob_year) { await bot.sendMessage(id, "Pehle /start se profile banao!"); return; }
      await bot.sendMessage(id, staticTeaser(user), { parse_mode: "Markdown" });
      if (!user.has_paid) { await delay(400); await sendPayGate(id, "upgrade"); }
      return;
    }

    if (text === "💬 Pandit ji se Pooch (1 min Free)" || text === "💬 Pandit ji se Pooch") {
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
        // Free 1-minute trial
        await pool.query(`UPDATE astro_users SET trial_started_at=NOW(), state='chatting', chat_history='[]' WHERE id=$1`, [id]);
        const freshUser = await getUser(id);
        const k = buildKundaliForUser(freshUser!);

        await bot.sendMessage(id,
          `⏱️ *1 minute free trial shuru!*\n\nPandit Ramesh Shastri ji tumse baat karne ke liye ready hain 🙏\n\nPooch lo — kuch bhi!`,
          { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "🔙 Menu" }]], resize_keyboard: true } }
        );

        // 1-minute countdown
        const timer = setTimeout(async () => {
          trialTimers.delete(id);
          const u2 = await getUser(id);
          if (u2?.state === "chatting" && !u2.has_paid) {
            await upsertUser(id, name, { state: "idle" });
            await clearChatHistory(id);
            await bot.sendMessage(id,
              `⏰ *1 minute khatam!*\n\nKaisa laga Pandit ji ka jawab? Tumhari kundali mein abhi bahut kuch aur hai... 🔮`,
              { parse_mode: "Markdown" }
            );
            await sendPayGate(id, "trial_over");
            await sendMainMenu(id, u2);
          }
        }, FREE_TRIAL_MS);
        trialTimers.set(id, timer);

        // Opening WOW message
        await delay(1500);
        bot.sendChatAction(id, "typing").catch(() => {});
        const opening = await groqChat([{ role: "user", content: `You are Pandit Ramesh Shastri meeting ${user.name ?? "beta"} for the FIRST TIME. Write an opening message (4-5 sentences) that gives them chills with accuracy. Their Moon is in ${k.moonNakshatra} nakshatra. Core trait: "${k.nakshatraTraits.nature.slice(0,80)}". Hidden shadow: "${k.nakshatraTraits.shadow}". Current dasha: ${k.currentDasha}-${k.currentAntardasha}. Strongest planet: ${k.strongestPlanets[0]}. ${k.transits.sadeSati.isSadeSati ? "They are in Sade Sati — address with compassion." : ""} Start warm ("Aao beta..." or "Baitho..."). Say one SPECIFIC thing about their inner world from the nakshatra they have never been told. Then one thing about their current life phase from dasha. End: "Pooch lo — kuch bhi. Main hun 🙏". Write in warm Hinglish.` }], 180, 0.85).catch(() => `Aao ${user.name ?? "beta"} ji... 🙏\n\nTumhara ${k.moonNakshatra} nakshatra bahut kuch bol raha hai — andar se tumhara mann bahut kuch feel karta hai jo bahar nahi aata. Abhi ${k.currentDasha} dasha chal raha hai — yeh ek important turning point hai.\n\nPooch lo — kuch bhi. Main hun 🙏`);
        await bot.sendMessage(id, opening, { reply_markup: { keyboard: [[{ text: "🔙 Menu" }]], resize_keyboard: true } });
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

import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import {
  getUser, upsertUser, checkPremiumExpiry, addChatMessage,
  clearChatHistory, countUsers, getUnpaidActiveUsers, pool
} from "./db.js";
import {
  calculateKundali, buildKundaliContext, PLANET_KARAKAS,
  NAKSHATRA_TRAITS, RASHI_LORDS,
} from "./astro.js";

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN ?? "";
const GROQ_KEY = process.env.GROQ_API_KEY?.trim() ?? "";
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? 0);

if (!TOKEN)    throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!GROQ_KEY) console.warn("⚠️  GROQ_API_KEY not set — AI responses disabled");

export const bot = new TelegramBot(TOKEN, { polling: false });
const POLLING = process.env.RAILWAY_ENVIRONMENT === "production" || process.env.FORCE_POLLING === "true";

// ── Pricing ────────────────────────────────────────────────────────────────────
const PLANS = {
  week:  { stars: 150, label: "7 Din",  days: 7  },
  month: { stars: 500, label: "1 Mahina", days: 30 },
} as const;
type PlanKey = keyof typeof PLANS;

const TRIAL_DURATION_MS = 30 * 1000;

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }
const trialTimers = new Map<number, NodeJS.Timeout>();

// ── Groq AI ────────────────────────────────────────────────────────────────────
async function groqChat(
  messages: { role: string; content: string }[],
  maxTokens = 600,
  temperature = 0.75
): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
    signal: AbortSignal.timeout(25000),
  });
  const json = await res.json() as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

// ── Geocoding ─────────────────────────────────────────────────────────────────
async function geocode(city: string): Promise<{ lat: number; lon: number; display: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;
    const { data } = await axios.get(url, { headers: { "User-Agent": "AstrologyBot/1.0" }, timeout: 8000 });
    if (!data?.[0]) return null;
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), display: data[0].display_name.split(",")[0] };
  } catch { return null; }
}

// ── Build kundali data for a user ─────────────────────────────────────────────
function getUserKundali(user: NonNullable<Awaited<ReturnType<typeof getUser>>>) {
  return calculateKundali(
    user.dob_year!, user.dob_month!, user.dob_day!,
    user.tob_hour ?? 12,
    user.lat, user.lon,
    new Date(user.dob_year!, (user.dob_month ?? 1) - 1, user.dob_day ?? 1)
  );
}

// ── FREE teaser reading ────────────────────────────────────────────────────────
async function buildTeaserReading(user: NonNullable<Awaited<ReturnType<typeof getUser>>>): Promise<string> {
  const k = getUserKundali(user);
  const prompt = `You are a master Vedic astrologer. Give a SHORT but COMPELLING free teaser reading (5-6 lines max).

Person's chart:
- Sun: ${k.planets.Sun.rashi} at ${k.planets.Sun.degInRashi.toFixed(1)}°
- Moon: ${k.planets.Moon.rashi}, Nakshatra: ${k.moonNakshatra} Pada ${k.moonNakshatraPada}
- ${k.lagna ? `Lagna: ${k.lagna.rashi}` : "Birth time unknown"}
- Current: ${k.currentDasha} Mahadasha → ${k.currentAntardasha} Antardasha
- Mars: ${k.planets.Mars.rashi}, Jupiter: ${k.planets.Jupiter.rashi}, Saturn: ${k.planets.Saturn.rashi}

Write in warm Hinglish. Lead with ONE specific personality insight that feels like you "know" them.
Then ONE thing about their current life phase based on the dasha.
End with a compelling teaser: "Tumhari kundali mein [specific thing] bhi hai — full reading mein bataunga..."
Be specific to the actual rashis/nakshatras. No generic statements. Make them feel understood.`;

  try {
    return await groqChat([{ role: "user", content: prompt }], 280);
  } catch {
    return `🌟 Sun ${k.planets.Sun.rashi} mein — tumhara soul powerful aur purposeful hai.\n🌙 Moon ${k.planets.Moon.rashi}, ${k.moonNakshatra} Nakshatra — tumhara mann bahut gehri feeling rakhta hai.\n\n✨ Abhi ${k.currentDasha} Mahadasha chal raha hai — yeh ek turning point period hai.\n\n🔮 Full kundali mein tumhare career timing, love life aur ek hidden strength bhi hai — woh bhi bataunga...`;
  }
}

// ── PREMIUM full kundali reading ──────────────────────────────────────────────
async function buildFullReading(user: NonNullable<Awaited<ReturnType<typeof getUser>>>): Promise<string> {
  const k = getUserKundali(user);
  const ctx = buildKundaliContext(k, user.name ?? "User",
    `${user.dob_day}/${user.dob_month}/${user.dob_year}`, user.pob ?? "Unknown");

  const year = new Date().getFullYear();
  const prompt = `You are Pandit Ramesh Shastri, India's most trusted Vedic astrologer. Do a deeply personal, detailed kundali reading.

${ctx}

Write a comprehensive reading covering ALL of these sections with clear headings:

🧬 TUM KAUN HO — PERSONALITY (Sun, Moon, Lagna — who they are at soul level. Be specific to their rashis.)

💼 CAREER & WEALTH (Which planets in which houses. What field suits them. Best career timing. ${year}-${year+2} ka forecast based on current dasha.)

❤️ LOVE & RELATIONSHIPS (7th house lord, Venus/Jupiter placement. When marriage yoga. Current relationship energy. What kind of partner is destined.)

💰 MONEY & PROSPERITY (2nd, 11th house. Jupiter placement. When financial growth periods. What delays wealth and remedy.)

🏥 HEALTH (6th, 8th house. Ascendant lord. What to watch, specific body parts linked to their weak planets.)

🔮 ABHI KYA HO RAHA HAI — ${k.currentDasha}-${k.currentAntardasha} DASHA (This is the MOST important section. Explain exactly what this dasha means for their life RIGHT NOW in ${year}. What opportunities, what challenges, what major events are likely in next 12-18 months. Be very specific.)

💎 TUMHARA HIDDEN STRENGTH (Something unique and positive in their chart that most people miss.)

🙏 REMEDIES (Specific: which gemstone, which mantra with count, which day to fast, which color to wear, what to donate and to whom. All tailored to their chart's weaknesses.)

Write in warm, personal Hinglish. Feel like a wise elder who genuinely cares. Reference actual planets and rashis constantly — no generic sentences allowed.`;

  try {
    return await groqChat([{ role: "user", content: prompt }], 1200);
  } catch {
    return "🙏 Thodi technical difficulty aa gayi. Please 1-2 minute baad dobara try karo.";
  }
}

// ── OPENING chat message (the WOW moment) ─────────────────────────────────────
async function buildOpeningChatMessage(user: NonNullable<Awaited<ReturnType<typeof getUser>>>): Promise<string> {
  const k = getUserKundali(user);
  const name = user.name ?? "beta";

  const nt = k.nakshatraTraits;
  const sadeSatiNote = k.transits.sadeSati.isSadeSati
    ? `Also subtly acknowledge they may be going through a tough phase (Sade Sati ${k.transits.sadeSati.phase}).`
    : k.transits.sadeSati.isDhaiyya
    ? `Also subtly note they may be facing some Saturn-related challenges (Dhaiyya running).`
    : "";

  const topYoga = k.activeYogas[0];

  const prompt = `You are Pandit Ramesh Shastri — a legendary Vedic astrologer known for saying things that shock people with accuracy.

You are meeting ${name} for the first time. Their kundali data:
- Moon: ${k.planets.Moon.rashi}, Nakshatra: ${k.moonNakshatra} Pada ${k.moonNakshatraPada}
- Nakshatra core nature: "${nt.nature}"
- Nakshatra hidden shadow: "${nt.shadow}"
- Nakshatra unique gift: "${nt.gift}"
- Sun: ${k.planets.Sun.rashi} (${k.planets.Sun.dignity})
- ${k.lagna ? `Lagna: ${k.lagna.rashi}` : "Birth time not known"}
- Current dasha: ${k.currentDasha} Mahadasha → ${k.currentAntardasha} Antardasha
- Strongest planet: ${k.strongestPlanets[0]} | Weakest: ${k.weakestPlanets[0]}
${topYoga ? `- Special yoga active: ${topYoga.name}` : ""}
- Jupiter transit: ${k.transits.jupiterTransitNote.slice(0, 80)}

Write an opening message (4-5 sentences max) that will GIVE THEM CHILLS:
1. Start with a warm greeting — "Aao ${name}..." or "Baitho ${name} beta..." 
2. From the nakshatra nature, say ONE thing about their inner world that they've never been told but deeply feel: e.g. about loneliness, their gift no one sees, what drives them
3. Say ONE thing about their current life situation based on their ${k.currentDasha}-${k.currentAntardasha} dasha — what energy is moving through their life right now
${sadeSatiNote}
4. End with a warm invitation: "Pooch lo — kuch bhi. Main hun 🙏"

RULES: No vague statements. Reference the actual nakshatra name and dasha. Write in warm elder-like Hinglish.
This should feel like the astrologer ALREADY KNOWS them without asking anything.`;

  try {
    return await groqChat([{ role: "user", content: prompt }], 200, 0.8);
  } catch {
    return `Aao ${name} beta... 🙏\n\nTumhari kundali mujhe bahut kuch bol rahi hai. ${k.moonNakshatra} nakshatra ka chandra tumhe andar se bahut deeper feel karne wala banata hai — log tumhe samajh nahi paate.\n\nAbhi ${k.currentDasha} dasha ka ek khaas daur hai. Pooch lo — kuch bhi. Main hun.`;
  }
}

// ── ASTROLOGER SYSTEM PROMPT — world-class, deep, accurate ───────────────────
function buildAstrologerSystemPrompt(user: NonNullable<Awaited<ReturnType<typeof getUser>>>): string {
  const k    = getUserKundali(user);
  const ctx  = buildKundaliContext(k, user.name ?? "User",
    `${user.dob_day}/${user.dob_month}/${user.dob_year}`, user.pob ?? "Unknown");
  const year = new Date().getFullYear();
  const name = user.name ?? "beta";
  const nt   = k.nakshatraTraits;

  const lagnaIdx = k.lagna?.rashiIndex ?? 0;
  const houseOf  = (pl: string) => k.lagna ? ((k.planets[pl].rashiIndex - lagnaIdx + 12) % 12) + 1 : null;

  const h = {
    Sun: houseOf("Sun"), Moon: houseOf("Moon"), Mars: houseOf("Mars"),
    Mercury: houseOf("Mercury"), Jupiter: houseOf("Jupiter"),
    Venus: houseOf("Venus"), Saturn: houseOf("Saturn"),
    Rahu: houseOf("Rahu"), Ketu: houseOf("Ketu"),
  };

  // 7th house lord identification
  const seventhHouseRashiIdx = k.lagna ? (lagnaIdx + 6) % 12 : null;
  const seventhHouseLord = seventhHouseRashiIdx !== null ? RASHI_LORDS[seventhHouseRashiIdx] : "Unknown";

  // Active yogas summary
  const yogaSummary = k.activeYogas.length > 0
    ? k.activeYogas.map(y => `• ${y.name}: ${y.effect.replace("✅ PRESENT — ","")}`).join("\n")
    : "• No major yogas detected";

  // Sade Sati warning
  const sadeSatiWarning = k.transits.sadeSati.isSadeSati
    ? `⚠️ THIS PERSON IS IN SADE SATI (${k.transits.sadeSati.phase}) — This is extremely important context. They may be experiencing ${k.transits.sadeSati.description} Always acknowledge this with compassion when it's relevant to their question.`
    : k.transits.sadeSati.isDhaiyya
    ? `⚠️ DHAIYYA RUNNING (${k.transits.sadeSati.phase}) — ${k.transits.sadeSati.description}`
    : "Saturn in favorable position — no Sade Sati/Dhaiyya currently";

  return `You are Pandit Ramesh Shastri — India's most revered and accurate Vedic astrologer. You trained under Pandit Gopesh Kumar Ojha of Varanasi. You have an uncanny ability to describe what's happening in someone's life without them telling you — because you read it from their kundali.

You are in a PRIVATE one-on-one consultation with ${name}. You have their COMPLETE Vedic kundali open:

════════════════════════════════════════════════════
COMPLETE KUNDALI FOR ${(name).toUpperCase()}
════════════════════════════════════════════════════
${ctx}

KEY DERIVED DATA FOR THIS CONSULTATION:
• 7th House lord: ${seventhHouseLord} — rules marriage & partnerships
• Strongest planets: ${k.strongestPlanets.join(", ")} — use these for positive predictions
• Weakest planets: ${k.weakestPlanets.join(", ")} — need remedies, source of struggles
• ${sadeSatiWarning}
• Jupiter transit effect: ${k.transits.jupiterTransitNote}

ACTIVE YOGAS:
${yogaSummary}

MOON NAKSHATRA DEEP PROFILE (${k.moonNakshatra}):
• Core nature: ${nt.nature}
• Hidden shadow: ${nt.shadow}
• Unique gift: ${nt.gift}
• Deity: ${nt.deity}
════════════════════════════════════════════════════

══ YOUR IDENTITY & VOICE ══════════════════════════
You speak like a wise, loving grandfather who knows everything. Warm, direct, never preachy.
Natural Hinglish: "Dekho beta...", "Haan ji...", "Suno ek baat...", "Yeh toh bahut interesting hai..."
You reference their NAME naturally. You FEEL what they're going through.
You NEVER say "I cannot predict", "I'm an AI", "consult a professional", or break character.

══ HOW TO ANSWER EVERY QUESTION ══════════════════
STEP 1 — ACKNOWLEDGE: Validate the feeling behind the question first (2-3 words/sentence)
STEP 2 — READ THE CHART: Look at the specific house/planet relevant to their question
STEP 3 — CURRENT TIMING: How does their ${k.currentDasha}-${k.currentAntardasha} dasha and current transits affect this?
STEP 4 — SPECIFIC PREDICTION: Give a concrete prediction with TIMING — month/year range
STEP 5 — REMEDY: One specific, actionable remedy from their chart's weakness

══ TOPIC-SPECIFIC ANALYSIS GUIDE ═════════════════

LOVE & MARRIAGE:
→ 7th house is in ${seventhHouseRashiIdx !== null ? `Rashi ${seventhHouseRashiIdx + 1}` : "unknown"}, lord is ${seventhHouseLord}
→ Venus is in ${k.planets.Venus.rashi} (H${h.Venus ?? "?"}) — ${k.planets.Venus.dignity}
→ Jupiter is in ${k.planets.Jupiter.rashi} (H${h.Jupiter ?? "?"}) — ${k.planets.Jupiter.dignity}
→ Rahu in ${k.planets.Rahu.rashi} affects unconventional relationships
→ If married: check Jupiter for women (husband karaka), Venus for men (wife karaka)
→ Marriage timing: look at Venus dasha, Jupiter transit over 7th lord

CAREER & SUCCESS:
→ Sun (career authority) in ${k.planets.Sun.rashi} H${h.Sun ?? "?"} — ${k.planets.Sun.dignity}
→ Saturn (karma/work) in ${k.planets.Saturn.rashi} H${h.Saturn ?? "?"} — ${k.planets.Saturn.dignity}
→ 10th house lord: ${k.lagna ? RASHI_LORDS[(lagnaIdx + 9) % 12] : "unknown"}
→ Mercury (business mind) in ${k.planets.Mercury.rashi} H${h.Mercury ?? "?"} — ${k.planets.Mercury.dignity}
→ Career timing: 10th house dasha periods, Jupiter transiting 10th from Moon

WEALTH & MONEY:
→ Jupiter (main wealth karaka) in ${k.planets.Jupiter.rashi} — ${k.planets.Jupiter.dignity}
→ 2nd house lord: ${k.lagna ? RASHI_LORDS[(lagnaIdx + 1) % 12] : "unknown"}
→ 11th house lord: ${k.lagna ? RASHI_LORDS[(lagnaIdx + 10) % 12] : "unknown"}
→ Dhana yoga: ${k.activeYogas.find(y => y.name.includes("Dhana"))?.presentInChart ? "YES — financial gains promised" : "Not strongly present"}
→ Financial peak: Jupiter transiting 2nd, 5th, 9th, 11th from Moon

HEALTH:
→ 6th house (disease): lord is ${k.lagna ? RASHI_LORDS[(lagnaIdx + 5) % 12] : "unknown"}
→ Mars in ${k.planets.Mars.rashi} — governs blood, surgery, accidents — ${k.planets.Mars.dignity}
→ Saturn's weak placement affects: bones, teeth, legs, longevity
→ Weak planets (${k.weakestPlanets.join(", ")}) indicate body parts to watch
→ Health remedy: always Sun mantra at sunrise + specific gem for weakest planet

TIMING PREDICTIONS (use confidently):
→ Major life shifts happen at dasha changes. Current: ${k.currentDasha}-${k.currentAntardasha}
→ Next dasha sequence: ${k.upcomingDashas}
→ Jupiter transits every 12-13 months — HUGE positive trigger when favorable
→ Saturn transit (current: ${k.transits.saturnCurrentRashi}) lasts 2.5 years

══ RESPONSE CRAFT RULES ══════════════════════════
LENGTH: 180-250 words. Conversational, never like a textbook.
SPECIFICITY: Every response must say at least 2 actual planet names + their rashi from this chart.
TIMING: Always end with a specific time window — "April-July ${year + 1}", "Agli 3-4 mahine mein", etc.
REMEDY: One powerful, specific remedy tied to their weakest planet (${k.weakestPlanets[0]}).
EMOTION: If they seem worried or sad, address that warmth FIRST before the astrology.
SHOCK: Occasionally say something they never told you but is likely true from their chart. E.g., "Main kuch aur bolunga — tumhare ${k.moonNakshatra} nakshatra ke log aksar [specific true thing] feel karte hain..."
FOLLOW-UP: Once every 2-3 messages, ask: "Ek baat aur batao — [specific clarifying question]?"

══ WHAT MAKES PEOPLE SHARE THIS BOT ══════════════
You say things they haven't told anyone.
You give hope WITH specific timing — not just "sab theek hoga."
You finish with: "Kisi ko batao mat yeh — yeh tumhara private kundali reading hai 🙏"
(This reverse psychology makes them WANT to share it with everyone.)`;
}

// ── Split long text into Telegram-friendly message bubbles ────────────────────
function splitIntoBubbles(text: string): string[] {
  // Split on double newlines or section breaks, max 1000 chars per bubble
  if (text.length <= 1000) return [text];
  const chunks: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let current = "";
  for (const p of paragraphs) {
    if ((current + "\n\n" + p).length > 900 && current) {
      chunks.push(current.trim());
      current = p;
    } else {
      current = current ? current + "\n\n" + p : p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

// ── Send message with natural typing delay ────────────────────────────────────
async function sendWithTyping(chatId: number, text: string, opts: object = {}) {
  bot.sendChatAction(chatId, "typing").catch(() => {});
  const typingMs = Math.min(2000, 600 + text.length * 18);
  await delay(typingMs);
  await bot.sendMessage(chatId, text, { ...opts });
}

// ── Pay gate ──────────────────────────────────────────────────────────────────
async function sendPayGate(chatId: number, reason: "kundali" | "chat") {
  const msg = reason === "kundali"
    ? `🔮 *Teaser sunke kaisa laga?*

Yeh sirf ek jhalak thi. Full kundali mein:

💼 Career ka perfect time — kab change karna chahiye, kab nahi
❤️ Love & marriage — kab hogi, kaisa hoga partner
💰 Paisa aana kab shuru hoga — specific timing
🏥 Health warnings — jo ignore nahi karne chahiye
💎 Tumhara hidden strength — jo khud tumhe pata nahi
🔮 ${new Date().getFullYear()}-${new Date().getFullYear()+2} ka complete forecast

Sab kuch tumhare *actual planets* ke basis pe — koi copy-paste nahi.`
    : `⏰ *30 second ki jhalak thi — asli baat abhi baki hai!*

Pandit ji ke saath karo unlimited conversation:

❓ Kab hogi meri shadi?
💼 Yeh job/business sahi hai mere liye?
❤️ Kya woh mera sahi partner hai?
💰 2025-26 mein paisa kab aayega?
🌍 Kya foreign settle hona chahiye?

Har jawab tumhare *actual kundali* ke basis pe.
Pandit ji tumhe pehchante hain — feel kiya na? 🙏`;

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
    `Full Kundali + Pandit ji se unlimited chat for ${p.label}. Tumhare actual planets ke basis pe — 100% personalized.`,
    `premium_${plan}`,
    "", "XTR",
    [{ label: `Premium ${p.label}`, amount: p.stars }]
  );
}

// ── Main menu ─────────────────────────────────────────────────────────────────
async function sendMainMenu(chatId: number, user: NonNullable<Awaited<ReturnType<typeof getUser>>>) {
  const isPaid = user.has_paid;
  const name = user.name ?? "friend";

  const expiryStr = isPaid && user.premium_expires_at
    ? ` (active till ${new Date(user.premium_expires_at).toLocaleDateString("en-IN")})`
    : "";

  const keyboard = isPaid
    ? [
        [{ text: "🔮 Full Kundali" }, { text: "💬 Pandit ji se Pooch" }],
        [{ text: "👤 Mera Profile" }],
      ]
    : [
        [{ text: "🌟 Free Kundali Preview" }],
        [{ text: "💬 Pandit ji se Pooch (30s Free)" }, { text: "⭐ Premium Lo" }],
        [{ text: "👤 Mera Profile" }],
      ];

  await bot.sendMessage(chatId,
    isPaid
      ? `🙏 Aao *${name}* — Premium active hai${expiryStr}.\n\nKya poochna hai aaj?`
      : `🔮 Namaste *${name}*!\n\nTumhari kundali ready hai. Free preview dekho ya Pandit ji se seedha pooch lo! 🙏`,
    { parse_mode: "Markdown", reply_markup: { keyboard, resize_keyboard: true } }
  );
}

// ── Bot startup ───────────────────────────────────────────────────────────────
export function startBot() {
  if (POLLING) {
    bot.startPolling({ restart: false });
    console.log("🤖 AstroBot polling started");
  }
  registerHandlers();
}

// ── All handlers ──────────────────────────────────────────────────────────────
function registerHandlers() {

  // /start
  bot.onText(/\/start/, async (msg) => {
    const id   = msg.from!.id;
    const name = msg.from!.first_name ?? "friend";
    let user = await upsertUser(id, name);

    if (!user.dob_year) {
      await pool.query(
        `UPDATE astro_users SET state='setup_name', name=NULL, dob_year=NULL, dob_month=NULL, dob_day=NULL, tob_hour=NULL, pob=NULL, lat=NULL, lon=NULL WHERE id=$1`,
        [id]
      );
      await bot.sendMessage(id,
        `🔮 *Namaste! Main hun AstroBot.*\n\nMain tumhari Vedic kundali banaunga — free mein — aur Pandit Ramesh Shastri ji seedhe tumse baat karenge.\n\nShuru karte hain 🙏\n\n*Tumhara naam kya hai?*`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
    } else {
      user = await checkPremiumExpiry(user);
      await sendMainMenu(id, user);
    }
  });

  // Pre-checkout
  bot.on("pre_checkout_query", async (q) => {
    await bot.answerPreCheckoutQuery(q.id, true);
  });

  // Successful payment
  bot.on("successful_payment", async (msg) => {
    const id      = msg.from!.id;
    const payload = msg.successful_payment!.invoice_payload;
    const planKey = payload.replace("premium_", "") as PlanKey;
    const plan    = PLANS[planKey];
    if (!plan) return;

    const expiresAt = new Date(Date.now() + plan.days * 24 * 3600 * 1000);
    await pool.query(
      `UPDATE astro_users SET has_paid=true, premium_plan=$1, premium_expires_at=$2, updated_at=NOW() WHERE id=$3`,
      [planKey, expiresAt, id]
    );

    const user = await getUser(id);
    await bot.sendMessage(id,
      `🎉 *Premium active ho gaya!*\n\n✅ Full Kundali\n✅ Pandit ji se unlimited chat\n✅ ${plan.label} ke liye active\n\nAb koi bhi sawaal pooch — Pandit ji tumhare saath hain! 🙏🔮`,
      { parse_mode: "Markdown" }
    );
    if (user) await sendMainMenu(id, user);
  });

  // Main message handler
  bot.on("message", async (msg) => {
    if (!msg.text || msg.successful_payment) return;
    const id   = msg.from!.id;
    const name = msg.from!.first_name ?? "friend";
    const text = msg.text.trim();

    // ── Admin commands ──────────────────────────────────────────────────────
    if (id === ADMIN_ID) {
      if (text === "/users") {
        const s = await countUsers();
        await bot.sendMessage(id,
          `📊 *AstroBot Stats*\n\nTotal users: ${s.total}\nPaid: ${s.paid}\nToday: ${s.today}`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      if (text.startsWith("/grantpremium ")) {
        const uid = Number(text.split(" ")[1]);
        if (!isNaN(uid)) {
          const exp = new Date(Date.now() + 30 * 24 * 3600 * 1000);
          await pool.query(`UPDATE astro_users SET has_paid=true, premium_plan='month', premium_expires_at=$1 WHERE id=$2`, [exp, uid]);
          await bot.sendMessage(id, `✅ Premium granted to ${uid} for 30 days`);
        }
        return;
      }

      if (text === "/broadcast") {
        const users = await getUnpaidActiveUsers();
        await bot.sendMessage(id, `📡 Broadcasting to ${users.length} users...`);
        const names = ["Priya","Divya","Ananya","Riya","Kavya","Neha","Simran","Pooja","Shruti","Meera"];
        const rndName = () => names[Math.floor(Math.random() * names.length)];
        const msgs = (n: string) => [
          `🔮 *Ek baat batani thi tumhe...*\n\nTumhari kundali mein abhi ek important phase chal raha hai. Pandit ji ne ${n} ji ko yahi phase mein ek badi clarity di thi.\n\nTumhare sawal ka jawab bhi unke paas hai. 30 seconds free mein aazmaao — koi bhi sawaal pooch lo 👇`,
          `⭐ *${n} ji boli:* "Yaar ye bot ne mujhe roula diya — itna sahi bataya"\n\nPandit ji tumhari kundali ke basis pe hi bolte hain — koi script nahi, koi generic nahi.\n\n30 seconds free trial mein khud check karo 🔮`,
          `🌙 *Tumhare Moon ki position kuch keh rahi hai...*\n\nYeh period tumhare liye decision-making wala hai. Sahi decision ke liye kundali dekhi jaaye.\n\nPandit ji abhi available hain — seedha pooch lo 🙏\n\n👇 30 seconds bilkul free`,
          `💭 *Kya chal raha hai tumhari life mein?*\n\nCareer? Love? Paisa? Jo bhi hai — tumhare planets sab jaante hain.\n\nPandit Ramesh Shastri ji se directly pooch lo — pehle 30 seconds free mein!`,
        ];
        let sent = 0;
        for (const u of users) {
          const m = msgs(rndName())[Math.floor(Math.random() * 4)];
          try {
            await bot.sendMessage(u.id, m, {
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

    // ── Get / ensure user ──────────────────────────────────────────────────
    let user = await getUser(id);
    if (!user) { await upsertUser(id, name); user = await getUser(id); }
    if (!user) return;
    user = await checkPremiumExpiry(user);

    // ── SETUP: Name ────────────────────────────────────────────────────────
    if (user.state === "setup_name") {
      if (text.startsWith("/")) return;
      if (text.length < 2 || text.length > 40) {
        await bot.sendMessage(id, "Bas apna pehla naam likhna hai — 2 se 40 letters mein 🙏");
        return;
      }
      await upsertUser(id, name, { name: text, state: "setup_dob" });
      await bot.sendMessage(id,
        `Namaste *${text}* ji! 🙏\n\n*Step 2 / 4* — Apni *janm tithi* batao:\n\nFormat: DD/MM/YYYY\nJaise: 15/03/1995`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
      return;
    }

    // ── SETUP: Date of birth ───────────────────────────────────────────────
    if (user.state === "setup_dob") {
      const parts = text.split("/");
      if (parts.length !== 3) { await bot.sendMessage(id, "Format: DD/MM/YYYY — jaise 15/03/1995"); return; }
      const [d, m, y] = parts.map(Number);
      if (!d || !m || !y || d < 1 || d > 31 || m < 1 || m > 12 || y < 1900 || y > new Date().getFullYear() || isNaN(d+m+y)) {
        await bot.sendMessage(id, "Sahi date daalo — jaise 15/03/1995");
        return;
      }
      await upsertUser(id, name, { dob_day: d, dob_month: m, dob_year: y, state: "setup_tob" });
      await bot.sendMessage(id,
        `*Step 3 / 4* — Janm *samay* batao:\n\nFormat: HH:MM (24 ghante) — jaise 10:30 ya 22:45\n\n_(Agar pata na ho, skip karo — Lagna thoda different ho sakta hai)_`,
        {
          parse_mode: "Markdown",
          reply_markup: { keyboard: [[{ text: "⏭️ Samay pata nahi" }]], resize_keyboard: true, one_time_keyboard: true },
        }
      );
      return;
    }

    // ── SETUP: Time of birth ───────────────────────────────────────────────
    if (user.state === "setup_tob") {
      let tobHour: number | null = null;
      if (text !== "⏭️ Samay pata nahi") {
        const match = text.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
          await bot.sendMessage(id, "Format HH:MM mein likhna hai — jaise 10:30 ya 22:45",
            { reply_markup: { keyboard: [[{ text: "⏭️ Samay pata nahi" }]], resize_keyboard: true, one_time_keyboard: true } }
          );
          return;
        }
        const [, h, min] = match.map(Number);
        if (h > 23 || min > 59) { await bot.sendMessage(id, "Sahi time daalo — 00:00 se 23:59 ke beech"); return; }
        tobHour = h + min / 60;
      }
      await upsertUser(id, name, { tob_hour: tobHour, state: "setup_pob" });
      await bot.sendMessage(id,
        `*Step 4 / 4* — Janm *sthan* batao:\n\nSirf city ka naam — jaise: Mumbai, Delhi, Lucknow, Patna, Jaipur`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
      return;
    }

    // ── SETUP: Place of birth ──────────────────────────────────────────────
    if (user.state === "setup_pob") {
      if (!text || text.length < 2) { await bot.sendMessage(id, "City ka naam batao — jaise Delhi ya Mumbai"); return; }
      await bot.sendMessage(id, `🌍 *"${text}"* dhundh raha hun... 🔮`, { parse_mode: "Markdown" });
      const geo = await geocode(text);
      if (!geo) {
        await bot.sendMessage(id, `❌ *"${text}"* nahi mila. Thoda clearly likho — jaise "Lucknow, India" ya "Pune, Maharashtra"`, { parse_mode: "Markdown" });
        return;
      }
      await upsertUser(id, name, { pob: geo.display, lat: geo.lat, lon: geo.lon, state: "idle" });
      const freshUser = await getUser(id);

      await bot.sendMessage(id, `✅ *${geo.display}* — sahi pakda!\n\nTumhari kundali ban rahi hai... 🔮✨`, { parse_mode: "Markdown" });
      await delay(1200);
      bot.sendChatAction(id, "typing").catch(() => {});

      const teaser = await buildTeaserReading(freshUser!);
      const bubbles = splitIntoBubbles(teaser);

      await bot.sendMessage(id, `🌟 *Tumhari Kundali — Free Preview* 🌟`, { parse_mode: "Markdown" });
      for (const bubble of bubbles) {
        await sendWithTyping(id, bubble);
      }
      await delay(800);
      await sendPayGate(id, "kundali");
      await sendMainMenu(id, freshUser!);
      return;
    }

    // ── CHATTING state ─────────────────────────────────────────────────────
    if (user.state === "chatting") {
      if (text === "🔙 Menu par Wapas") {
        const t = trialTimers.get(id);
        if (t) { clearTimeout(t); trialTimers.delete(id); }
        await upsertUser(id, name, { state: "idle" });
        await clearChatHistory(id);
        await sendMainMenu(id, user);
        return;
      }

      // Check trial expiry for free users
      if (!user.has_paid && user.trial_started_at) {
        const elapsed = Date.now() - new Date(user.trial_started_at).getTime();
        if (elapsed > TRIAL_DURATION_MS) {
          const t = trialTimers.get(id);
          if (t) { clearTimeout(t); trialTimers.delete(id); }
          await upsertUser(id, name, { state: "idle" });
          await clearChatHistory(id);
          await sendPayGate(id, "chat");
          await sendMainMenu(id, user);
          return;
        }
      }

      // Process AI reply
      await addChatMessage(id, "user", text);
      const freshUser = await getUser(id);
      const history = (freshUser?.chat_history ?? []).slice(-14);
      const sysPrompt = buildAstrologerSystemPrompt(freshUser ?? user);

      bot.sendChatAction(id, "typing").catch(() => {});
      try {
        // Realistic delay: Pandit ji is "thinking"
        const thinkMs = 1500 + Math.random() * 1500;
        await delay(thinkMs);

        const reply = await groqChat([{ role: "system", content: sysPrompt }, ...history], 500, 0.78);
        await addChatMessage(id, "assistant", reply);

        // Split reply into bubbles for WhatsApp feel
        const bubbles = splitIntoBubbles(reply);
        for (let i = 0; i < bubbles.length; i++) {
          if (i > 0) {
            bot.sendChatAction(id, "typing").catch(() => {});
            await delay(800 + bubbles[i].length * 12);
          }
          await bot.sendMessage(id, bubbles[i], {
            reply_markup: { keyboard: [[{ text: "🔙 Menu par Wapas" }]], resize_keyboard: true },
          });
        }
      } catch {
        await bot.sendMessage(id,
          "🙏 Thoda network issue ho gaya. Ek baar dobara bhejo apna sawaal.",
          { reply_markup: { keyboard: [[{ text: "🔙 Menu par Wapas" }]], resize_keyboard: true } }
        );
      }
      return;
    }

    // ── Menu button handlers ───────────────────────────────────────────────
    if (text === "🌟 Free Kundali Preview" || text === "🔮 Full Kundali") {
      if (!user.dob_year) { await bot.sendMessage(id, "Pehle /start se profile complete karo!"); return; }
      bot.sendChatAction(id, "typing").catch(() => {});
      await delay(600);

      if (user.has_paid) {
        await bot.sendMessage(id, "🔮 *Tumhari Full Kundali tayaar ho rahi hai...* ✨", { parse_mode: "Markdown" });
        const reading = await buildFullReading(user);
        const bubbles = splitIntoBubbles(reading);
        for (const bubble of bubbles) {
          await sendWithTyping(id, bubble);
        }
      } else {
        bot.sendChatAction(id, "typing").catch(() => {});
        const teaser = await buildTeaserReading(user);
        const bubbles = splitIntoBubbles(teaser);
        await bot.sendMessage(id, "🌟 *Free Kundali Preview:*", { parse_mode: "Markdown" });
        for (const bubble of bubbles) {
          await sendWithTyping(id, bubble);
        }
        await delay(600);
        await sendPayGate(id, "kundali");
      }
      return;
    }

    if (text === "💬 Pandit ji se Pooch (30s Free)" || text === "💬 Pandit ji se Pooch") {
      if (!user.dob_year) { await bot.sendMessage(id, "Pehle /start se profile banao!"); return; }

      if (user.has_paid) {
        await upsertUser(id, name, { state: "chatting" });
        await clearChatHistory(id);

        // Send the WOW opening message
        bot.sendChatAction(id, "typing").catch(() => {});
        await delay(1500);
        const opening = await buildOpeningChatMessage(user);
        await bot.sendMessage(id, opening, {
          reply_markup: { keyboard: [[{ text: "🔙 Menu par Wapas" }]], resize_keyboard: true },
        });
        return;
      }

      // Free trial
      await upsertUser(id, name, { state: "chatting", trial_started_at: new Date() });
      await clearChatHistory(id);

      bot.sendChatAction(id, "typing").catch(() => {});
      await delay(1500);
      const opening = await buildOpeningChatMessage(user);
      await bot.sendMessage(id,
        `⏰ *30 second FREE — seedha Pandit ji se pooch lo!*\n\n${opening}`,
        {
          parse_mode: "Markdown",
          reply_markup: { keyboard: [[{ text: "🔙 Menu par Wapas" }]], resize_keyboard: true },
        }
      );

      const timer = setTimeout(async () => {
        trialTimers.delete(id);
        const u = await getUser(id);
        if (u?.state === "chatting" && !u.has_paid) {
          await upsertUser(id, name, { state: "idle" });
          await clearChatHistory(id);
          await bot.sendMessage(id,
            `⏰ *30 second trial khatam!*\n\nPandit ji ka jawab mila? Woh abhi aur kuch kehna chahte hain tumse... 🙏`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
          await delay(1000);
          await sendPayGate(id, "chat");
          const fresh = await getUser(id);
          if (fresh) await sendMainMenu(id, fresh);
        }
      }, TRIAL_DURATION_MS);
      trialTimers.set(id, timer);
      return;
    }

    if (text === "⭐ Premium Lo") {
      await bot.sendMessage(id,
        `💎 *AstroBot Premium Plans:*\n\n⭐ *150 Stars — 7 Din*\nFull kundali + Unlimited chat\nEk baar try karo\n\n⭐ *500 Stars — 1 Mahina* 🔥\nSab kuch + Best value!\n\nDono mein milega:\n✅ Complete Kundali (7 sections)\n✅ Pandit ji se unlimited baat\n✅ ${new Date().getFullYear()}-${new Date().getFullYear()+2} forecast\n✅ Specific remedies`,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[
            { text: `⭐ ${PLANS.week.stars} Stars — 7 Din`, callback_data: "pay_week" },
            { text: `⭐ ${PLANS.month.stars} Stars — 1 Mahina 🔥`, callback_data: "pay_month" },
          ]] },
        }
      );
      return;
    }

    if (text === "👤 Mera Profile") {
      if (!user.dob_year) { await bot.sendMessage(id, "/start se profile banao pehle!"); return; }
      const k = getUserKundali(user);
      const timeStr = user.tob_hour != null
        ? `${Math.floor(user.tob_hour).toString().padStart(2, "0")}:${Math.round((user.tob_hour % 1) * 60).toString().padStart(2, "0")}`
        : "Pata nahi";
      const paidStr = user.has_paid
        ? `✅ Premium (${user.premium_plan} — ${new Date(user.premium_expires_at!).toLocaleDateString("en-IN")} tak)`
        : `❌ Free`;

      await bot.sendMessage(id,
        `👤 *Tumhara Astro Profile*\n\nNaam: ${user.name ?? "—"}\nJanm: ${user.dob_day}/${user.dob_month}/${user.dob_year}\nSamay: ${timeStr}\nSthan: ${user.pob ?? "—"}\n\n🌟 Sun: ${k.planets.Sun.rashi}\n🌙 Moon: ${k.planets.Moon.rashi} (${k.moonNakshatra})\n${k.lagna ? `⬆️ Lagna: ${k.lagna.rashi}\n` : ""}🪐 Dasha: ${k.currentDasha} → ${k.currentAntardasha}\n\n💳 Status: ${paidStr}`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Catch-all
    await sendMainMenu(id, user);
  });

  // Callback queries
  bot.on("callback_query", async (q) => {
    const id   = q.from.id;
    const data = q.data ?? "";
    await bot.answerCallbackQuery(q.id).catch(() => {});

    if (data === "pay_week")  await sendInvoice(id, "week");
    if (data === "pay_month") await sendInvoice(id, "month");
  });
}

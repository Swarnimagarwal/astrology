import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import {
  getUser, upsertUser, checkPremiumExpiry, addChatMessage,
  clearChatHistory, countUsers, getUnpaidActiveUsers, pool
} from "./db.js";
import {
  julianDay, calculateKundali, buildKundaliContext,
  getRashi, getNakshatra, PLANET_SIGNIFICATIONS,
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
  month: { stars: 150, label: "1 Month",  days: 30  },
  year:  { stars: 500, label: "1 Year",   days: 365 },
} as const;
type PlanKey = keyof typeof PLANS;

const TRIAL_DURATION_MS = 30 * 1000; // 30 seconds astrologer chat free trial

// ── Groq AI ────────────────────────────────────────────────────────────────────
async function groqChat(messages: { role: string; content: string }[], maxTokens = 500): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({ model: "llama-3.1-8b-instant", messages, max_tokens: maxTokens, temperature: 0.7 }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json() as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

// ── Geocoding via Nominatim (free, no API key) ─────────────────────────────────
async function geocode(city: string): Promise<{ lat: number; lon: number; display: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;
    const { data } = await axios.get(url, { headers: { "User-Agent": "AstrologyBot/1.0" }, timeout: 8000 });
    if (!data?.[0]) return null;
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), display: data[0].display_name.split(",")[0] };
  } catch { return null; }
}

// ── Teaser kundali (free) ──────────────────────────────────────────────────────
async function buildTeaserReading(user: NonNullable<Awaited<ReturnType<typeof getUser>>>): Promise<string> {
  if (!user.dob_year) return "Please complete your profile first.";

  const hourUT = user.tob_hour ?? 12;
  const k = calculateKundali(
    user.dob_year, user.dob_month!, user.dob_day!,
    hourUT, user.lat, user.lon,
    new Date(user.dob_year, (user.dob_month ?? 1) - 1, user.dob_day ?? 1)
  );

  const sunRashi  = k.planets.Sun.rashi;
  const moonRashi = k.planets.Moon.rashi;
  const lagnaStr  = k.lagna ? k.lagna.rashi : "Unknown (birth time needed)";
  const nakshatra = k.moonNakshatra;

  const prompt = `You are an expert Vedic astrologer. Give a SHORT teaser reading (max 5 sentences) for:
Sun in ${sunRashi}, Moon in ${moonRashi}, Lagna: ${lagnaStr}, Moon Nakshatra: ${nakshatra}.
Running ${k.currentDasha} Mahadasha with ${k.currentAntardasha} Antardasha.

Give 2-3 key personality traits and 1-2 life themes RIGHT NOW based on the dasha.
Write in a compelling Hinglish style. End with a cliffhanger about what their FULL kundali reveals.
Be specific — mention the actual planets and signs. No generic stuff.`;

  try {
    return await groqChat([{ role: "user", content: prompt }], 300);
  } catch {
    return `🌟 Sun in ${sunRashi} — tumhara soul creative aur confident hai.\n🌙 Moon in ${moonRashi} — emotionally ${moonRashi.includes("Karka") ? "sensitive aur nurturing" : "strong aur practical"}.\n✨ Moon Nakshatra ${nakshatra} mein — bahut kuch aur reveal karna baki hai...\n\n🔮 Full kundali mein: tumhara career, love life, aur 2024-2025 predictions — sab kuch!`;
  }
}

// ── Full kundali reading (premium) ────────────────────────────────────────────
async function buildFullReading(user: NonNullable<Awaited<ReturnType<typeof getUser>>>): Promise<string> {
  if (!user.dob_year) return "Profile incomplete.";

  const hourUT = user.tob_hour ?? 12;
  const k = calculateKundali(
    user.dob_year, user.dob_month!, user.dob_day!,
    hourUT, user.lat, user.lon,
    new Date(user.dob_year, (user.dob_month ?? 1) - 1, user.dob_day ?? 1)
  );

  const ctx = buildKundaliContext(k, user.name ?? "User",
    `${user.dob_day}/${user.dob_month}/${user.dob_year}`, user.pob ?? "Unknown");

  const prompt = `You are a master Vedic astrologer with 30 years experience. Do a DETAILED analysis for:

${ctx}

Write a comprehensive kundali reading covering:
1. PERSONALITY & SOUL (Sun, Moon, Lagna analysis)
2. CAREER & WEALTH (2nd, 6th, 10th house planets, their dashas)  
3. LOVE & MARRIAGE (7th house, Venus, Jupiter analysis)
4. HEALTH (6th, 8th house, ascendant lord)
5. CURRENT LIFE PHASE (${k.currentDasha} Mahadasha + ${k.currentAntardasha} Antardasha — what this means RIGHT NOW in 2024-2025)
6. KEY STRENGTHS & CHALLENGES
7. REMEDIES (specific gemstone, mantra, day to fast)

Be very specific — reference actual planets in actual rashis. No vague or generic statements.
Write in detailed Hinglish. Make it feel like a personal one-on-one reading.`;

  try {
    return await groqChat([{ role: "user", content: prompt }], 1000);
  } catch (e) {
    return "AI temporarily unavailable. Please try again in a moment.";
  }
}

// ── Astrologer chat system prompt ─────────────────────────────────────────────
function buildAstrologerSystemPrompt(user: NonNullable<Awaited<ReturnType<typeof getUser>>>): string {
  const hourUT = user.tob_hour ?? 12;
  const k = calculateKundali(
    user.dob_year!, user.dob_month!, user.dob_day!,
    hourUT, user.lat, user.lon,
    new Date(user.dob_year!, (user.dob_month ?? 1) - 1, user.dob_day ?? 1)
  );
  const ctx = buildKundaliContext(k, user.name ?? "User",
    `${user.dob_day}/${user.dob_month}/${user.dob_year}`, user.pob ?? "Unknown");

  return `You are Pandit Ramesh Shastri, a renowned Vedic astrologer with 30+ years of experience. You are having a personal consultation with ${user.name ?? "a user"}.

You have their complete kundali in front of you:

${ctx}

YOUR ROLE:
- Answer their specific questions based on their ACTUAL planetary positions and dashas above
- Be specific — always reference the real planets and rashis in their chart
- Give genuine Vedic astrology analysis, not generic advice
- Mention their current ${k.currentDasha}-${k.currentAntardasha} dasha and how it affects their question
- Suggest specific remedies when relevant (gemstone, mantra, fasting day, charity)
- Write in Hinglish — warm, personal, like a real pandit talking to someone

IMPORTANT: Every answer MUST reference specific planets from their chart. NEVER give generic answers.
If asked about love: check their 7th house, Venus, Jupiter position
If asked about career: check 10th house, 6th house, Saturn, Sun position
If asked about health: check 6th, 8th house and ascendant lord
If asked about money: check 2nd, 11th house, Jupiter, Venus position

Keep answers detailed but conversational — 150-250 words per response.`;
}

// ── Pay gate ──────────────────────────────────────────────────────────────────
async function sendPayGate(chatId: number, reason: "kundali" | "chat") {
  const msg = reason === "kundali"
    ? `🔮 *Tumhara Teaser Padhha — Ab Full Kundali Unlock Karo!*\n\nIs teaser mein sirf jhhalkiyan thi. Full reading mein:\n\n💼 *Career predictions 2024-2026*\n💕 *Love & marriage analysis*\n💰 *Wealth & financial timing*\n🏥 *Health warnings & remedies*\n⭐ *Lucky gemstone, mantra & fast*\n🔮 *Current dasha ka pura effect*\n\nSab kuch tumhare actual planets ke basis pe — koi generic nahi!`
    : `⏰ *Free trial khatam hua!*\n\nPandit ji ke saath unlimited baat karo — apni life ke kisi bhi sawaal ka jawab pao:\n\n❓ Kab hogi meri shadi?\n💼 Yeh job change sahi rahega?\n🌍 Kya foreign jana theek hai?\n💰 Kab aayega paisa?\n❤️ Kya woh meri life partner hai?\n\nHar jawab tumhare ACTUAL kundali ke basis pe — 100% personalized!`;

  await bot.sendMessage(chatId, msg, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: `⭐ ${PLANS.month.stars} Stars — ${PLANS.month.label}`, callback_data: "pay_month" },
          { text: `⭐ ${PLANS.year.stars} Stars — ${PLANS.year.label} 🔥`, callback_data: "pay_year" },
        ],
      ],
    },
  });
}

async function sendInvoice(chatId: number, plan: PlanKey) {
  const p = PLANS[plan];
  await bot.sendInvoice(
    chatId,
    `🔮 AstroBot Premium — ${p.label}`,
    `Full Kundali + Unlimited Astrologer Chat for ${p.label}. 100% personalized Vedic analysis.`,
    `premium_${plan}`,
    "",
    "XTR",
    [{ label: `Premium ${p.label}`, amount: p.stars }]
  );
}

// ── Main menu ─────────────────────────────────────────────────────────────────
async function sendMainMenu(chatId: number, user: NonNullable<Awaited<ReturnType<typeof getUser>>>) {
  const isPaid = user.has_paid;
  const name = user.name ?? "friend";

  const keyboard = isPaid
    ? [[{ text: "🔮 Full Kundali" }, { text: "💬 Astrologer Chat" }], [{ text: "👤 My Profile" }]]
    : [[{ text: "🔮 My Kundali (Free Preview)" }], [{ text: "💬 Ask Astrologer (30s Free)" }, { text: "⭐ Go Premium" }], [{ text: "👤 My Profile" }]];

  await bot.sendMessage(chatId,
    isPaid
      ? `✨ Welcome back, *${name}*! Premium active 🎉\n\nKya poochna chahte ho aaj?`
      : `🔮 Namaste *${name}*! Tumhara kundali ready hai.\n\nFree mein preview dekho ya astrologer se seedha pooch lo!`,
    { parse_mode: "Markdown", reply_markup: { keyboard, resize_keyboard: true } }
  );
}

// ── Typing simulation ─────────────────────────────────────────────────────────
function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Trial tracker ─────────────────────────────────────────────────────────────
const trialTimers = new Map<number, NodeJS.Timeout>();

// ── Start polling ─────────────────────────────────────────────────────────────
export function startBot() {
  if (POLLING) {
    bot.startPolling({ restart: false });
    console.log("🤖 AstroBot polling started (Railway mode)");
  } else {
    console.log("🤖 AstroBot initialized (webhook/dev mode)");
  }
  registerHandlers();
}

// ── Handlers ──────────────────────────────────────────────────────────────────
function registerHandlers() {
  // /start
  bot.onText(/\/start/, async (msg) => {
    const id   = msg.from!.id;
    const name = msg.from!.first_name ?? "friend";
    let user = await upsertUser(id, name);

    if (!user.dob_year) {
      await pool.query(`UPDATE astro_users SET state='setup_name', name=NULL, dob_year=NULL, dob_month=NULL, dob_day=NULL, tob_hour=NULL, pob=NULL, lat=NULL, lon=NULL WHERE id=$1`, [id]);
      await bot.sendMessage(id,
        `🔮 *Namaste! Main hun AstroBot* — Vedic kundali aur astrologer chat, bilkul free mein shuru karo!\n\n*Main tumhari janm kundali banaunga aur seedhe sawaal ke jawab dunga.*\n\nSabse pehle — *tumhara naam kya hai?* 🙏`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
    } else {
      user = await checkPremiumExpiry(user);
      await sendMainMenu(id, user);
    }
  });

  // Pre-checkout query (required for Stars payments)
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
      `🎉 *Premium activated!* Welcome to AstroBot Premium!\n\n✅ Full Kundali unlocked\n✅ Unlimited Astrologer Chat\n✅ Active for ${plan.label}\n\nAb koi bhi sawaal pooch Pandit ji se! 🔮`,
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

    // Admin commands
    if (id === ADMIN_ID) {
      if (text === "/users") {
        const stats = await countUsers();
        await bot.sendMessage(id, `📊 *AstroBot Stats*\n\nTotal: ${stats.total}\nPaid: ${stats.paid}\nToday: ${stats.today}`, { parse_mode: "Markdown" });
        return;
      }
      if (text === "/broadcast") {
        const users = await getUnpaidActiveUsers();
        await bot.sendMessage(id, `📡 Sending to ${users.length} users...`);
        const names = ["Priya","Divya","Ananya","Riya","Kavya","Neha","Simran","Pooja"];
        const rndName = () => names[Math.floor(Math.random() * names.length)];
        let sent = 0;
        for (const u of users) {
          const n = rndName();
          const msgs = [
            `🔮 *Tumhari kundali mein kuch khaas dikh raha hai...*\n\n${n} ji ne bhi yahi poochha tha jo tum soch rahe ho abhi.\n\n*Full reading aur Pandit ji se seedha pooch lo* — sirf ⭐ 150 Stars mein!\n\n👇 Abhi unlock karo`,
            `⭐ *Aaj ka shubh muhurat tumhare liye hai!*\n\nTumhari current dasha mein ek important decision aane wala hai.\n\n*Pandit ji se pooch lo — kya karna chahiye?*\n\n🔮 30 seconds FREE trial → Tab decide karo!`,
            `🌟 *${n} ji ne poochha:* "Kya mera career change sahi rahega?"\n\nPandit ji ne unki kundali dekhi aur seedha jawab diya.\n\n*Tumhara sawaal kya hai?* Premium lo aur seedha pooch lo! 🔮`,
          ];
          const m = msgs[Math.floor(Math.random() * msgs.length)];
          try {
            await bot.sendMessage(u.id, m, {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[
                { text: "⭐ 150 Stars — 1 Month", callback_data: "pay_month" },
                { text: "⭐ 500 Stars — 1 Year 🔥", callback_data: "pay_year" },
              ]] },
            });
            sent++;
          } catch { /* user blocked */ }
          await delay(80);
        }
        await bot.sendMessage(id, `✅ Broadcast done! Sent: ${sent}/${users.length}`);
        return;
      }
    }

    let user = await getUser(id);
    if (!user) {
      await upsertUser(id, name);
      user = await getUser(id);
    }
    if (!user) return;
    user = await checkPremiumExpiry(user);

    // ── Setup flow ──────────────────────────────────────────────────────────

    if (user.state === "setup_name") {
      if (!text || text.length < 2 || text.length > 40) {
        await bot.sendMessage(id, "Please enter your first name (2-40 characters).");
        return;
      }
      await upsertUser(id, name, { name: text, state: "setup_dob" });
      await bot.sendMessage(id,
        `Namaste *${text}*! 🙏\n\n*Step 2 of 4* — Apni *janm tithi* batao:\n\nFormat: DD/MM/YYYY\nExample: 15/03/1995`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
      return;
    }

    if (user.state === "setup_dob") {
      const parts = text.split("/");
      if (parts.length !== 3) {
        await bot.sendMessage(id, "Format: DD/MM/YYYY — jaise 15/03/1995");
        return;
      }
      const [d, m, y] = parts.map(Number);
      if (!d || !m || !y || d < 1 || d > 31 || m < 1 || m > 12 || y < 1900 || y > 2010 || isNaN(d) || isNaN(m) || isNaN(y)) {
        await bot.sendMessage(id, "Sahi date daalo — jaise 15/03/1995");
        return;
      }
      await upsertUser(id, name, { dob_day: d, dob_month: m, dob_year: y, state: "setup_tob" });
      await bot.sendMessage(id,
        `*Step 3 of 4* — Janm *samay* batao (zyada accurate kundali ke liye):\n\nFormat: HH:MM (24-hour) — jaise 10:30 ya 22:45\n\nYa tap karo agar pata nahi:`,
        {
          parse_mode: "Markdown",
          reply_markup: { keyboard: [[{ text: "⏭ Samay pata nahi (skip)" }]], resize_keyboard: true, one_time_keyboard: true },
        }
      );
      return;
    }

    if (user.state === "setup_tob") {
      let tobHour: number | null = null;
      if (text !== "⏭ Samay pata nahi (skip)") {
        const match = text.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
          await bot.sendMessage(id, "Format HH:MM mein batao — jaise 10:30 ya 22:45\n\nYa skip karo agar pata nahi:", {
            reply_markup: { keyboard: [[{ text: "⏭ Samay pata nahi (skip)" }]], resize_keyboard: true, one_time_keyboard: true },
          });
          return;
        }
        const [, h, min] = match.map(Number);
        if (h > 23 || min > 59) {
          await bot.sendMessage(id, "Sahi time daalo — jaise 10:30");
          return;
        }
        tobHour = h + min / 60;
      }
      await upsertUser(id, name, { tob_hour: tobHour, state: "setup_pob" });
      await bot.sendMessage(id,
        `*Step 4 of 4* — Janm *sthan* batao:\n\nSirf city ka naam likho — jaise: Mumbai, Delhi, Lucknow, Jaipur`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
      return;
    }

    if (user.state === "setup_pob") {
      if (!text || text.length < 2) {
        await bot.sendMessage(id, "City ka naam batao — jaise Delhi, Mumbai, Lucknow");
        return;
      }
      await bot.sendMessage(id, `🌍 *${text}* dhundh raha hun... ek second! 🔮`, { parse_mode: "Markdown" });
      const geo = await geocode(text);
      if (!geo) {
        await bot.sendMessage(id, `❌ "${text}" nahi mila. Thoda aur clearly likho — jaise "Lucknow, India"`);
        return;
      }
      await upsertUser(id, name, { pob: geo.display, lat: geo.lat, lon: geo.lon, state: "idle" });
      const updatedUser = await getUser(id);
      await bot.sendMessage(id, `✅ *${geo.display}* — sahi hai!\n\nTumhari kundali tayaar ho rahi hai... 🔮✨`, { parse_mode: "Markdown" });

      // Show teaser immediately
      await delay(1000);
      bot.sendChatAction(id, "typing").catch(() => {});
      const teaser = await buildTeaserReading(updatedUser!);
      await bot.sendMessage(id, `🌟 *Tumhari Kundali — Free Preview* 🌟\n\n${teaser}`, { parse_mode: "Markdown" });
      await delay(1500);
      await sendPayGate(id, "kundali");
      await sendMainMenu(id, updatedUser!);
      return;
    }

    // ── Chatting state ──────────────────────────────────────────────────────
    if (user.state === "chatting") {
      if (text === "🔙 Back to Menu") {
        const timer = trialTimers.get(id);
        if (timer) { clearTimeout(timer); trialTimers.delete(id); }
        await upsertUser(id, name, { state: "idle" });
        await clearChatHistory(id);
        await sendMainMenu(id, user);
        return;
      }

      // Check if trial expired (for free users)
      if (!user.has_paid && user.trial_started_at) {
        const elapsed = Date.now() - new Date(user.trial_started_at).getTime();
        if (elapsed > TRIAL_DURATION_MS) {
          const timer = trialTimers.get(id);
          if (timer) { clearTimeout(timer); trialTimers.delete(id); }
          await upsertUser(id, name, { state: "idle" });
          await clearChatHistory(id);
          await sendPayGate(id, "chat");
          await sendMainMenu(id, user);
          return;
        }
      }

      // AI reply
      bot.sendChatAction(id, "typing").catch(() => {});
      await addChatMessage(id, "user", text);
      const freshUser = await getUser(id);
      const history = (freshUser?.chat_history ?? []).slice(-12);

      const sysPrompt = buildAstrologerSystemPrompt(freshUser ?? user);
      try {
        const typingDelay = 1200 + Math.random() * 1200;
        await delay(typingDelay);
        const reply = await groqChat([
          { role: "system", content: sysPrompt },
          ...history,
        ], 400);
        await addChatMessage(id, "assistant", reply);
        await bot.sendMessage(id, reply, {
          reply_markup: { keyboard: [[{ text: "🔙 Back to Menu" }]], resize_keyboard: true },
        });
      } catch {
        await bot.sendMessage(id, "🙏 Ek second... thoda network issue hai. Dobara pooch lo.", {
          reply_markup: { keyboard: [[{ text: "🔙 Back to Menu" }]], resize_keyboard: true },
        });
      }
      return;
    }

    // ── Main menu buttons ───────────────────────────────────────────────────
    if (text === "🔮 My Kundali (Free Preview)" || text === "🔮 Full Kundali") {
      if (!user.dob_year) { await bot.sendMessage(id, "Pehle /start se profile banao!"); return; }
      bot.sendChatAction(id, "typing").catch(() => {});
      await delay(800);

      if (user.has_paid) {
        const reading = await buildFullReading(user);
        // Split long message if needed
        const chunks = reading.match(/[\s\S]{1,4000}/g) ?? [reading];
        for (const chunk of chunks) {
          await bot.sendMessage(id, chunk);
          await delay(300);
        }
      } else {
        const teaser = await buildTeaserReading(user);
        await bot.sendMessage(id, `🌟 *Free Kundali Preview*\n\n${teaser}`, { parse_mode: "Markdown" });
        await delay(500);
        await sendPayGate(id, "kundali");
      }
      return;
    }

    if (text === "💬 Ask Astrologer (30s Free)" || text === "💬 Astrologer Chat") {
      if (!user.dob_year) { await bot.sendMessage(id, "Pehle /start se profile banao!"); return; }

      if (user.has_paid) {
        await upsertUser(id, name, { state: "chatting" });
        await clearChatHistory(id);
        await bot.sendMessage(id,
          `🙏 *Pandit Ramesh Shastri ji ki seva mein aapka swagat hai!*\n\nTumhari kundali mere samne hai. Koi bhi sawaal pooch sakte ho:\n\n💼 Career, 💕 Love/Marriage, 💰 Money, 🏥 Health, 🌍 Travel...\n\nKya poochna hai?`,
          { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "🔙 Back to Menu" }]], resize_keyboard: true } }
        );
        return;
      }

      // Free trial
      await upsertUser(id, name, { state: "chatting", trial_started_at: new Date() });
      await clearChatHistory(id);
      await bot.sendMessage(id,
        `🙏 *Pandit Ramesh Shastri ji ki seva mein aapka swagat hai!*\n\n⏰ *30 seconds FREE trial* — seedha pooch lo!\n\nTumhari kundali mere samne hai. Kya poochna hai?`,
        { parse_mode: "Markdown", reply_markup: { keyboard: [[{ text: "🔙 Back to Menu" }]], resize_keyboard: true } }
      );

      // Auto-end trial after 30 seconds
      const timer = setTimeout(async () => {
        trialTimers.delete(id);
        const u = await getUser(id);
        if (u?.state === "chatting" && !u.has_paid) {
          await upsertUser(id, name, { state: "idle" });
          await clearChatHistory(id);
          await bot.sendMessage(id,
            `⏰ *30 second free trial khatam hua!*\n\nPandit ji ke jawab achhe lage? Ab unlimited pooch sakte ho! 🔮`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
          await sendPayGate(id, "chat");
          const freshUser = await getUser(id);
          if (freshUser) await sendMainMenu(id, freshUser);
        }
      }, TRIAL_DURATION_MS);
      trialTimers.set(id, timer);
      return;
    }

    if (text === "⭐ Go Premium") {
      await bot.sendMessage(id,
        `💎 *AstroBot Premium — Plans:*\n\n⭐ *150 Stars — 1 Month*\n• Full kundali reading\n• Unlimited astrologer chat\n• Daily horoscope\n\n⭐ *500 Stars — 1 Year*\n• Sab kuch + best value!\n\n100% personalized — tumhare actual planets ke basis pe!`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "⭐ 150 Stars — 1 Month", callback_data: "pay_month" },
              { text: "⭐ 500 Stars — 1 Year 🔥", callback_data: "pay_year" },
            ]],
          },
        }
      );
      return;
    }

    if (text === "👤 My Profile") {
      if (!user.dob_year) { await bot.sendMessage(id, "Profile abhi complete nahi hai. /start se banao!"); return; }
      const timeStr = user.tob_hour != null
        ? `${Math.floor(user.tob_hour).toString().padStart(2,"0")}:${Math.round((user.tob_hour % 1) * 60).toString().padStart(2,"0")}`
        : "Unknown";
      const premiumStr = user.has_paid
        ? `✅ Premium (${user.premium_plan} — expires ${new Date(user.premium_expires_at!).toLocaleDateString()})`
        : "❌ Free user";

      const k = calculateKundali(user.dob_year, user.dob_month!, user.dob_day!, user.tob_hour ?? 12, user.lat, user.lon,
        new Date(user.dob_year, (user.dob_month ?? 1) - 1, user.dob_day ?? 1));

      await bot.sendMessage(id,
        `👤 *Tumhara Profile*\n\nNaam: ${user.name}\nJanm: ${user.dob_day}/${user.dob_month}/${user.dob_year}\nSamay: ${timeStr}\nSthan: ${user.pob ?? "Unknown"}\n\n🌟 Sun: ${k.planets.Sun.rashi}\n🌙 Moon: ${k.planets.Moon.rashi} (${k.moonNakshatra})\n${k.lagna ? `⬆️ Lagna: ${k.lagna.rashi}\n` : ""}🔮 Dasha: ${k.currentDasha}-${k.currentAntardasha}\n\n💳 Status: ${premiumStr}`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Unrecognized input — show menu
    await sendMainMenu(id, user);
  });

  // Callback queries (inline keyboard)
  bot.on("callback_query", async (q) => {
    const id   = q.from.id;
    const data = q.data ?? "";
    await bot.answerCallbackQuery(q.id).catch(() => {});

    if (data === "pay_month") await sendInvoice(id, "month");
    if (data === "pay_year")  await sendInvoice(id, "year");
  });
}

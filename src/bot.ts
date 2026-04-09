import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import {
  getUser, upsertUser, checkPremiumExpiry, pool,
  countUsers, getUnpaidActiveUsers,
} from "./db.js";
import {
  calculateKundali, RASHIS, RASHI_LORDS,
} from "./astro.js";

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN ?? "";
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? 0);

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

export const bot = new TelegramBot(TOKEN, { polling: false });
const POLLING =
  process.env.RAILWAY_ENVIRONMENT === "production" ||
  process.env.FORCE_POLLING === "true";

// ── Pricing ───────────────────────────────────────────────────────────────────
const PLANS = {
  week:  { stars: 150, label: "7 Din",   days: 7  },
  month: { stars: 500, label: "1 Mahina", days: 30 },
} as const;
type PlanKey = keyof typeof PLANS;

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Geocoding (OpenStreetMap Nominatim — free, no API key) ───────────────────
async function geocode(city: string): Promise<{ lat: number; lon: number; display: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "AstrologyBot/1.0" }, timeout: 8000,
    });
    if (!data?.[0]) return null;
    return {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
      display: data[0].display_name.split(",")[0],
    };
  } catch { return null; }
}

// ── Build kundali for a user ──────────────────────────────────────────────────
function getUserKundali(user: NonNullable<Awaited<ReturnType<typeof getUser>>>) {
  return calculateKundali(
    user.dob_year!, user.dob_month!, user.dob_day!,
    user.tob_hour ?? 12,
    user.lat, user.lon,
    new Date(user.dob_year!, (user.dob_month ?? 1) - 1, user.dob_day ?? 1)
  );
}

// ── Planet emoji map ──────────────────────────────────────────────────────────
const P_EMOJI: Record<string, string> = {
  Sun: "☀️", Moon: "🌙", Mars: "♂️", Mercury: "☿", Jupiter: "♃",
  Venus: "♀️", Saturn: "♄", Rahu: "☊", Ketu: "☋",
};
const DIGNITY_EMOJI: Record<string, string> = {
  Exalted: "✨", "Own Sign": "🏠", Friend: "👍", Neutral: "", Enemy: "⚠️", Debilitated: "🔻",
};

// ── FREE kundali preview (shown after setup) ──────────────────────────────────
function buildFreePreview(user: NonNullable<Awaited<ReturnType<typeof getUser>>>): string {
  const k    = getUserKundali(user);
  const name = user.name ?? "ji";

  const sadeSatiLine = k.transits.sadeSati.isSadeSati
    ? `\n⚠️ *Sade Sati chal raha hai* (${k.transits.sadeSati.phase}) — yeh ek important phase hai.`
    : k.transits.sadeSati.isDhaiyya
    ? `\n⚠️ *Dhaiyya chal raha hai* (${k.transits.sadeSati.phase})`
    : "";

  const activeYogaLine = k.activeYogas.length > 0
    ? `\n✨ *Tumhare chart mein ${k.activeYogas.length} special yoga(s) hain* — jaise ${k.activeYogas[0].name}${k.activeYogas.length > 1 ? ` aur ${k.activeYogas.length - 1} aur` : ""}`
    : "";

  return `🌟 *${name} ji ki FREE Kundali Preview* 🌟
━━━━━━━━━━━━━━━━━━━━━━━━

☀️ *Sun:* ${k.planets.Sun.rashi} — ${k.planets.Sun.dignity}
🌙 *Moon:* ${k.planets.Moon.rashi} — ${k.planets.Moon.dignity}
${k.lagna ? `🌅 *Lagna:* ${k.lagna.rashi}` : `🌅 Lagna: _(birth time dene se milega)_`}

🌙 *Nakshatra:* ${k.moonNakshatra} Pada ${k.moonNakshatraPada}

⏰ *Abhi chal raha hai:* ${k.currentDasha} Mahadasha → ${k.currentAntardasha} Antardasha
📅 *Dasha kab tak:* ${k.dashaBalance}
${sadeSatiLine}${activeYogaLine}

━━━━━━━━━━━━━━━━━━━━━━━━
🔒 _Full kundali mein: saare 9 graha, dignitiy, saare yogas, Sade Sati, current transits, aur life areas analysis — sab tumhare actual planets ke basis pe_`;
}

// ── FULL kundali (premium) ────────────────────────────────────────────────────
function buildFullKundali(user: NonNullable<Awaited<ReturnType<typeof getUser>>>): string[] {
  const k    = getUserKundali(user);
  const name = user.name ?? "ji";
  const dob  = `${user.dob_day}/${user.dob_month}/${user.dob_year}`;
  const tob  = user.tob_hour != null
    ? `${String(Math.floor(user.tob_hour)).padStart(2,"0")}:${String(Math.round((user.tob_hour % 1) * 60)).padStart(2,"0")}`
    : "Unknown";

  // ── Page 1: Header + Planets ──────────────────────────────────────────────
  const planetLines = (["Sun","Moon","Mars","Mercury","Jupiter","Venus","Saturn","Rahu","Ketu"] as const)
    .map(p => {
      const pos = k.planets[p];
      const dig = (p !== "Rahu" && p !== "Ketu") ? ` — ${pos.dignity} ${DIGNITY_EMOJI[pos.dignity] ?? ""}` : "";
      return `${P_EMOJI[p]} *${p.padEnd(8)}:* ${pos.rashi} ${pos.degInRashi.toFixed(1)}°${dig}`;
    }).join("\n");

  const lagnaLine = k.lagna
    ? `\n🌅 *Lagna (ASC):* ${k.lagna.rashi} ${k.lagna.degInRashi.toFixed(1)}°`
    : "\n🌅 *Lagna:* Not available (birth time needed)";

  const page1 = `🔮 *${name} ji ki FULL Vedic Kundali*
━━━━━━━━━━━━━━━━━━━━━━━━
📅 DOB: ${dob} | ⏰ TOB: ${tob}
📍 POB: ${user.pob ?? "Unknown"}
━━━━━━━━━━━━━━━━━━━━━━━━

🪐 *GRAHA (Planetary Positions)*
${planetLines}${lagnaLine}

🏆 *Strongest planets:* ${k.strongestPlanets.join(", ")} — inka use karo
⚠️ *Weakest planets:* ${k.weakestPlanets.join(", ")} — inhe sambhalo`;

  // ── Page 2: Nakshatra + Dasha ─────────────────────────────────────────────
  const nt = k.nakshatraTraits;
  const page2 = `🌙 *NAKSHATRA ANALYSIS*
━━━━━━━━━━━━━━━━━━━━━━━━

Moon Nakshatra: *${k.moonNakshatra}* Pada ${k.moonNakshatraPada}
Deity: ${nt.deity}
Symbol: ${nt.symbol}

📖 *Core nature:* ${nt.nature}

🌑 *Hidden shadow:* ${nt.shadow}

🎁 *Unique gift:* ${nt.gift}

━━━━━━━━━━━━━━━━━━━━━━━━
⏰ *VIMSHOTTARI DASHA*

Current: *${k.currentDasha} Mahadasha → ${k.currentAntardasha} Antardasha*
${k.dashaBalance}

Next dashas: ${k.upcomingDashas}`;

  // ── Page 3: Yogas ─────────────────────────────────────────────────────────
  const activeYogas = k.activeYogas;
  const yogaText = activeYogas.length > 0
    ? activeYogas.map(y => `✅ *${y.name}*\n   ${y.effect.replace("✅ PRESENT — ","")}`).join("\n\n")
    : "No major yogas active in this chart.";

  const page3 = `✨ *ACTIVE YOGAS IN YOUR CHART* (${activeYogas.length} found)
━━━━━━━━━━━━━━━━━━━━━━━━

${yogaText}

${activeYogas.length === 0 ? "_Yogas form specific planetary combinations. Your chart has simpler placements — focus on your strongest planets._" : ""}`;

  // ── Page 4: Transits + Sade Sati ─────────────────────────────────────────
  const tr = k.transits;
  const sadeSatiStatus = tr.sadeSati.isSadeSati
    ? `🔴 *SADE SATI CHAL RAHA HAI!*\n*Phase:* ${tr.sadeSati.phase}\n\n${tr.sadeSati.description}`
    : tr.sadeSati.isDhaiyya
    ? `🟡 *DHAIYYA CHAL RAHA HAI*\n*Phase:* ${tr.sadeSati.phase}\n\n${tr.sadeSati.description}`
    : `✅ *Sade Sati/Dhaiyya nahi chal raha* — Saturn ki position normal hai`;

  const page4 = `🪐 *CURRENT PLANETARY TRANSITS*
━━━━━━━━━━━━━━━━━━━━━━━━

♄ *Saturn abhi:* ${tr.saturnCurrentRashi}
♃ *Jupiter abhi:* ${tr.jupiterCurrentRashi}
☊ *Rahu abhi:* ${tr.rahuCurrentRashi} | ☋ Ketu: ${tr.ketuCurrentRashi}

━━━━━━━━━━━━━━━━━━━━━━━━
*SADE SATI STATUS:*
${sadeSatiStatus}

━━━━━━━━━━━━━━━━━━━━━━━━
*JUPITER TRANSIT EFFECT:*
${tr.jupiterTransitNote}`;

  // ── Page 5: Life areas analysis (static, based on planet placements) ──────
  const lagnaIdx  = k.lagna?.rashiIndex ?? 0;
  const houseOf   = (p: string) => k.lagna ? ((k.planets[p].rashiIndex - lagnaIdx + 12) % 12) + 1 : null;
  const h7thLord  = k.lagna ? RASHI_LORDS[(lagnaIdx + 6) % 12] : "Unknown";
  const h10thLord = k.lagna ? RASHI_LORDS[(lagnaIdx + 9) % 12] : "Unknown";
  const h2ndLord  = k.lagna ? RASHI_LORDS[(lagnaIdx + 1) % 12] : "Unknown";

  // Career analysis
  const sunH   = houseOf("Sun");
  const satH   = houseOf("Saturn");
  const careerStr = `Sun ${k.planets.Sun.rashi} (H${sunH ?? "?"}) — ${k.planets.Sun.dignity === "Exalted" ? "bahut strong career authority" : k.planets.Sun.dignity === "Debilitated" ? "career mein extra mehnat lagegi" : "normal career strength"}. Saturn ${k.planets.Saturn.rashi} (H${satH ?? "?"}) — ${k.planets.Saturn.dignity === "Own Sign" || k.planets.Saturn.dignity === "Exalted" ? "karma acha hai, discipline se success" : "patience aur consistency zaroori hai"}. 10th lord: ${h10thLord}.`;

  // Love analysis
  const venH = houseOf("Venus");
  const jupH = houseOf("Jupiter");
  const loveStr = `Venus ${k.planets.Venus.rashi} (H${venH ?? "?"}) — ${k.planets.Venus.dignity === "Exalted" ? "love life mein bahut sukh" : k.planets.Venus.dignity === "Debilitated" ? "relationships mein kuch challenges" : "normal love life"}. Jupiter ${k.planets.Jupiter.rashi} (H${jupH ?? "?"}) — ${k.planets.Jupiter.dignity === "Exalted" || k.planets.Jupiter.dignity === "Own Sign" ? "excellent for marriage blessings" : "Jupiter ki strength average hai"}. 7th lord: ${h7thLord}.`;

  // Wealth analysis
  const wealthStr = `2nd lord: ${h2ndLord}. Jupiter (wealth karaka) in ${k.planets.Jupiter.rashi} — ${k.planets.Jupiter.dignity}. ${k.activeYogas.some(y => y.name.includes("Dhana")) ? "✅ Dhana Yoga present — financial success strong hai!" : "Dhana Yoga absent — paisa mehnat se aayega."}`;

  const page5 = `💼 *LIFE AREAS ANALYSIS*
━━━━━━━━━━━━━━━━━━━━━━━━

🏢 *Career & Success*
${careerStr}

❤️ *Love & Marriage*
${loveStr}

💰 *Wealth & Money*
${wealthStr}

━━━━━━━━━━━━━━━━━━━━━━━━
_Yeh analysis tumhare actual graha positions par based hai. Timing predictions ke liye apne dasha period ko dhyan mein rakho._

🙏 _Kundali padhne ke liye dhanyavaad!_`;

  return [page1, page2, page3, page4, page5];
}

// ── Pay gate ──────────────────────────────────────────────────────────────────
async function sendPayGate(chatId: number) {
  await bot.sendMessage(chatId,
    `🔒 *Full Kundali unlock karo!*

Tumhe milega:
🪐 Saare 9 graha ki exact position + dignity
✨ Yoga analysis (Gaja Kesari, Hamsa, etc.)
🌙 Nakshatra ka deep profile (deity, gift, shadow)
⏰ Full Dasha timeline + upcoming dashas
🪐 Current Saturn/Jupiter transit analysis
🔴 Sade Sati/Dhaiyya status
💼 Life areas: career, love, money — sab actual planets se

_100% tumhare actual birth data se — koi generic reading nahi_`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: `⭐ ${PLANS.week.stars} Stars — 7 Din`, callback_data: "pay_week" },
          { text: `⭐ ${PLANS.month.stars} Stars — 1 Mahina 🔥`, callback_data: "pay_month" },
        ]],
      },
    }
  );
}

async function sendInvoice(chatId: number, plan: PlanKey) {
  const p = PLANS[plan];
  await bot.sendInvoice(
    chatId,
    `🔮 AstroBot Premium — ${p.label}`,
    `Full Vedic Kundali with all 9 planets, yogas, dasha, Sade Sati & transit analysis. ${p.label} access.`,
    `premium_${plan}`,
    "", "XTR",
    [{ label: `Premium ${p.label}`, amount: p.stars }]
  );
}

// ── Main menu ─────────────────────────────────────────────────────────────────
async function sendMainMenu(chatId: number, user: NonNullable<Awaited<ReturnType<typeof getUser>>>) {
  const isPaid = user.has_paid;
  const name   = user.name ?? "friend";
  const expiry = isPaid && user.premium_expires_at
    ? ` (active till ${new Date(user.premium_expires_at).toLocaleDateString("en-IN")})`
    : "";

  const keyboard = isPaid
    ? [
        [{ text: "🔮 Free Preview" }, { text: "💎 Full Kundali (Premium)" }],
        [{ text: "👤 Mera Profile" }, { text: "🔄 Profile Reset" }],
      ]
    : [
        [{ text: "🔮 Free Preview" }],
        [{ text: "💎 Full Kundali Dekho" }, { text: "⭐ Premium Lo" }],
        [{ text: "👤 Mera Profile" }],
      ];

  await bot.sendMessage(chatId,
    isPaid
      ? `🙏 Namaste *${name}* ji — Premium active${expiry}.\n\nKya dekhna hai aaj?`
      : `🔮 Namaste *${name}* ji!\n\nTumhari kundali ready hai. Free preview dekho ya full kundali unlock karo! 🙏`,
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
    let user   = await upsertUser(id, name);

    if (!user.dob_year) {
      await pool.query(
        `UPDATE astro_users SET state='setup_name', name=NULL, dob_year=NULL, dob_month=NULL, dob_day=NULL, tob_hour=NULL, pob=NULL, lat=NULL, lon=NULL WHERE id=$1`,
        [id]
      );
      await bot.sendMessage(id,
        `🔮 *Namaste! Main hun AstroBot.*\n\nMain tumhari Vedic kundali banaunga — free mein — bilkul accurate, tumhare actual birth data se.\n\nShuru karte hain 🙏\n\n*Step 1/4 — Tumhara naam kya hai?*`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
    } else {
      user = await checkPremiumExpiry(user);
      await sendMainMenu(id, user);
    }
  });

  // /kundali shortcut
  bot.onText(/\/kundali/, async (msg) => {
    const id = msg.from!.id;
    let user = await getUser(id);
    if (!user || !user.dob_year) {
      await bot.sendMessage(id, "Pehle /start se apni birth details daalo — phir kundali milegi! 🔮");
      return;
    }
    user = await checkPremiumExpiry(user);
    if (user.has_paid) {
      await bot.sendMessage(id, "🔮 *Tumhari Full Kundali tayaar ho rahi hai...* ✨", { parse_mode: "Markdown" });
      const pages = buildFullKundali(user);
      for (const page of pages) {
        await delay(400);
        await bot.sendMessage(id, page, { parse_mode: "Markdown" });
      }
    } else {
      await bot.sendMessage(id, buildFreePreview(user), { parse_mode: "Markdown" });
      await delay(500);
      await sendPayGate(id);
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
      `🎉 *Premium active ho gaya!*\n\n✅ Full Kundali (5 pages)\n✅ Saare yogas, dasha, transits\n✅ ${plan.label} ke liye active\n\n*/kundali* type karo ya neeche button dabaao 🙏🔮`,
      { parse_mode: "Markdown" }
    );
    if (user) await sendMainMenu(id, user);
  });

  // Callback queries (inline buttons)
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
          await pool.query(
            `UPDATE astro_users SET has_paid=true, premium_plan='month', premium_expires_at=$1 WHERE id=$2`,
            [exp, uid]
          );
          await bot.sendMessage(id, `✅ Premium granted to ${uid} for 30 days`);
        }
        return;
      }

      if (text === "/broadcast") {
        const users = await getUnpaidActiveUsers();
        await bot.sendMessage(id, `📡 Broadcasting to ${users.length} users...`);
        let sent = 0;
        const msgs = [
          `🔮 *Tumhari kundali mein kuch khaas hai...*\n\nTumhare Moon ki nakshatra position ek unique insight deti hai — jo log apne baare mein jaanna chahte hain unhe yeh zaroor dekhna chahiye.\n\n*/kundali* type karo — Free preview abhi milega 👇`,
          `🪐 *Kya chal raha hai tumhari life mein?*\n\nCareer shift? Love ka confusion? Paisa ka tension?\n\nTumhare planets sab jaante hain — apni Free kundali dekho:\n*/kundali* 🔮`,
          `⭐ *Saturn ka transit tumhari rashi pe hai?*\n\nSade Sati check karo — yeh 7.5 saal ka period bahut important hota hai.\n\nFree check: */kundali* type karo 🙏`,
        ];
        for (const u of users) {
          const m = msgs[Math.floor(Math.random() * msgs.length)];
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

    // ── Get / ensure user ───────────────────────────────────────────────────
    let user = await getUser(id);
    if (!user) { await upsertUser(id, name); user = await getUser(id); }
    if (!user) return;
    user = await checkPremiumExpiry(user);

    // ── SETUP: Name ─────────────────────────────────────────────────────────
    if (user.state === "setup_name") {
      if (text.startsWith("/")) return;
      if (text.length < 2 || text.length > 40) {
        await bot.sendMessage(id, "Bas apna pehla naam likhna hai — 2 se 40 letters mein 🙏");
        return;
      }
      await upsertUser(id, name, { name: text, state: "setup_dob" });
      await bot.sendMessage(id,
        `Namaste *${text}* ji! 🙏\n\n*Step 2/4* — Apni *janm tithi* batao:\n\nFormat: DD/MM/YYYY\nJaise: 15/03/1995`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
      return;
    }

    // ── SETUP: Date of birth ────────────────────────────────────────────────
    if (user.state === "setup_dob") {
      const parts = text.split("/");
      if (parts.length !== 3) {
        await bot.sendMessage(id, "Format: DD/MM/YYYY — jaise 15/03/1995");
        return;
      }
      const [d, m, y] = parts.map(Number);
      if (!d || !m || !y || d < 1 || d > 31 || m < 1 || m > 12 || y < 1900 || y > new Date().getFullYear() || isNaN(d + m + y)) {
        await bot.sendMessage(id, "Sahi date daalo — jaise 15/03/1995");
        return;
      }
      await upsertUser(id, name, { dob_day: d, dob_month: m, dob_year: y, state: "setup_tob" });
      await bot.sendMessage(id,
        `✅ DOB save ho gaya!\n\n*Step 3/4* — Janm *samay* batao:\n\nFormat: HH:MM (24 ghante) — jaise 10:30 ya 22:45\n\n_(Agar pata na ho, "Skip" dabaao — Lagna thoda different hoga par baaki sab sahi rahega)_`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            keyboard: [[{ text: "⏭️ Skip (samay pata nahi)" }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }
      );
      return;
    }

    // ── SETUP: Time of birth ────────────────────────────────────────────────
    if (user.state === "setup_tob") {
      let tobHour: number | null = null;
      if (text !== "⏭️ Skip (samay pata nahi)") {
        const match = text.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
          await bot.sendMessage(id,
            "Format HH:MM mein likhna hai — jaise 10:30 ya 22:45",
            { reply_markup: { keyboard: [[{ text: "⏭️ Skip (samay pata nahi)" }]], resize_keyboard: true, one_time_keyboard: true } }
          );
          return;
        }
        const [, h, min] = match.map(Number);
        if (h > 23 || min > 59) {
          await bot.sendMessage(id, "Sahi time daalo — 00:00 se 23:59 ke beech");
          return;
        }
        tobHour = h + min / 60;
      }
      await upsertUser(id, name, { tob_hour: tobHour, state: "setup_pob" });
      await bot.sendMessage(id,
        `✅ Time save!\n\n*Step 4/4* — Janm *sthan* batao:\n\nSirf city ka naam — jaise: Mumbai, Delhi, Lucknow, Patna, Jaipur`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
      return;
    }

    // ── SETUP: Place of birth ───────────────────────────────────────────────
    if (user.state === "setup_pob") {
      if (!text || text.length < 2) {
        await bot.sendMessage(id, "City ka naam batao — jaise Delhi ya Mumbai");
        return;
      }
      await bot.sendMessage(id, `🌍 *"${text}"* dhundh raha hun...`, { parse_mode: "Markdown" });
      const geo = await geocode(text);
      if (!geo) {
        await bot.sendMessage(id,
          `❌ *"${text}"* nahi mila.\n\nThoda clearly likho — jaise "Lucknow, India" ya "Pune, Maharashtra"`,
          { parse_mode: "Markdown" }
        );
        return;
      }
      await upsertUser(id, name, { pob: geo.display, lat: geo.lat, lon: geo.lon, state: "idle" });
      const freshUser = await getUser(id);

      await bot.sendMessage(id,
        `✅ *${geo.display}* — perfect!\n\n🔮 Tumhari kundali ban rahi hai...`,
        { parse_mode: "Markdown" }
      );
      await delay(1000);

      await bot.sendMessage(id, buildFreePreview(freshUser!), { parse_mode: "Markdown" });
      await delay(600);
      await sendPayGate(id);
      await sendMainMenu(id, freshUser!);
      return;
    }

    // ── Menu button: Free Preview ──────────────────────────────────────────
    if (text === "🔮 Free Preview") {
      if (!user.dob_year) { await bot.sendMessage(id, "Pehle /start se profile complete karo!"); return; }
      await bot.sendMessage(id, buildFreePreview(user), { parse_mode: "Markdown" });
      if (!user.has_paid) {
        await delay(400);
        await sendPayGate(id);
      }
      return;
    }

    // ── Menu button: Full Kundali ──────────────────────────────────────────
    if (text === "💎 Full Kundali Dekho" || text === "💎 Full Kundali (Premium)") {
      if (!user.dob_year) { await bot.sendMessage(id, "Pehle /start se profile complete karo!"); return; }

      if (!user.has_paid) {
        await sendPayGate(id);
        return;
      }

      await bot.sendMessage(id, "🔮 *Tumhari Full Vedic Kundali tayaar ho rahi hai...* ✨", { parse_mode: "Markdown" });
      const pages = buildFullKundali(user);
      for (let i = 0; i < pages.length; i++) {
        await delay(500);
        await bot.sendMessage(id, pages[i], { parse_mode: "Markdown" });
      }
      return;
    }

    // ── Menu button: Premium Lo ────────────────────────────────────────────
    if (text === "⭐ Premium Lo") {
      await sendPayGate(id);
      return;
    }

    // ── Menu button: Mera Profile ──────────────────────────────────────────
    if (text === "👤 Mera Profile") {
      const u = user;
      const dob = u.dob_year ? `${u.dob_day}/${u.dob_month}/${u.dob_year}` : "Not set";
      const tob = u.tob_hour != null
        ? `${String(Math.floor(u.tob_hour)).padStart(2,"0")}:${String(Math.round((u.tob_hour % 1) * 60)).padStart(2,"0")}`
        : "Not provided";
      const status = u.has_paid
        ? `✅ Premium (${u.premium_plan ?? "active"})${u.premium_expires_at ? ` — expires ${new Date(u.premium_expires_at).toLocaleDateString("en-IN")}` : ""}`
        : "🔒 Free user";

      await bot.sendMessage(id,
        `👤 *Tumhara Profile*\n\n📛 Name: ${u.name ?? "Not set"}\n📅 DOB: ${dob}\n⏰ TOB: ${tob}\n📍 POB: ${u.pob ?? "Not set"}\n⭐ Status: ${status}`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ── Menu button: Profile Reset ─────────────────────────────────────────
    if (text === "🔄 Profile Reset") {
      await pool.query(
        `UPDATE astro_users SET state='setup_name', name=NULL, dob_year=NULL, dob_month=NULL, dob_day=NULL, tob_hour=NULL, pob=NULL, lat=NULL, lon=NULL WHERE id=$1`,
        [id]
      );
      await bot.sendMessage(id,
        `🔄 Profile reset ho gaya!\n\n*Tumhara naam kya hai?*`,
        { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
      );
      return;
    }

    // ── Fallback ───────────────────────────────────────────────────────────
    if (user.state === "idle" && user.dob_year) {
      await sendMainMenu(id, user);
    } else if (!user.dob_year) {
      await bot.sendMessage(id, "Pehle /start se profile banao! 🔮");
    }
  });
}

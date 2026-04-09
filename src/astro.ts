// ═══════════════════════════════════════════════════════════════════════════════
// VEDIC KUNDALI ENGINE
// Astronomical accuracy:
//   Sun    — Meeus Ch.25,  ~0.01° error
//   Moon   — Meeus Ch.47,  ~0.3°  error  (30+ perturbation terms)
//   Planets— JPL Keplerian elements, ~1-2° error (sufficient: signs = 30°)
//   Rahu   — Standard lunar-node formula, ~0.1° error
//   Ayanamsha — Lahiri (used by Govt. of India, most Vedic software)
// ═══════════════════════════════════════════════════════════════════════════════

function toRad(d: number) { return d * Math.PI / 180; }
function toDeg(r: number) { return r * 180 / Math.PI; }
function norm360(a: number): number { a = a % 360; return a < 0 ? a + 360 : a; }

// ── Julian Day ────────────────────────────────────────────────────────────────
export function julianDay(year: number, month: number, day: number, hourUT = 12): number {
  if (month <= 2) { year -= 1; month += 12; }
  const A = Math.floor(year / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + hourUT / 24 + B - 1524.5;
}

// ── Lahiri Ayanamsha ──────────────────────────────────────────────────────────
export function lahiriAyanamsha(jd: number): number {
  const T = (jd - 2451545.0) / 36525;
  return 23.85319 + 0.013964 * (T * 100);
}

// ── Sun (Meeus Ch.25, ~0.01°) ─────────────────────────────────────────────────
export function sunLongitudeTropical(jd: number): number {
  const T  = (jd - 2451545.0) / 36525;
  const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M  = norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const Mr = toRad(M);
  const C  = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr)
           + (0.019993 - 0.000101 * T) * Math.sin(2 * Mr)
           + 0.000289 * Math.sin(3 * Mr);
  const Om = norm360(125.04452 - 1934.136261 * T);
  return norm360(L0 + C - 0.00569 - 0.00478 * Math.sin(toRad(Om)));
}

// ── Moon (Meeus Ch.47, ~0.3°) ─────────────────────────────────────────────────
export function moonLongitudeTropical(jd: number): number {
  const T  = (jd - 2451545.0) / 36525;
  const Lp = norm360(218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + T * T * T / 538841);
  const D  = norm360(297.8501921 + 445267.1114034  * T - 0.0018819 * T * T + T * T * T / 545868);
  const M  = norm360(357.52911   + 35999.05029     * T - 0.0001537 * T * T);
  const Mp = norm360(134.9633964 + 477198.8676313  * T + 0.0089970 * T * T + T * T * T / 69699);
  const F  = norm360(93.2720950  + 483202.0175233  * T - 0.0036539 * T * T);
  const E  = 1 - 0.002516 * T - 0.0000074 * T * T;
  const sig = 6.288774 * Math.sin(toRad(Mp))
    + 1.274027 * Math.sin(toRad(2*D - Mp))
    + 0.658314 * Math.sin(toRad(2*D))
    + 0.213618 * Math.sin(toRad(2*Mp))
    - 0.185116 * E * Math.sin(toRad(M))
    - 0.114332 * Math.sin(toRad(2*F))
    + 0.058793 * Math.sin(toRad(2*D - 2*Mp))
    + 0.057066 * E * Math.sin(toRad(2*D - M - Mp))
    + 0.053322 * Math.sin(toRad(2*D + Mp))
    + 0.045758 * E * Math.sin(toRad(2*D - M))
    - 0.040923 * E * Math.sin(toRad(M - Mp))
    - 0.034720 * Math.sin(toRad(D))
    - 0.030383 * E * Math.sin(toRad(M + Mp))
    + 0.015327 * Math.sin(toRad(2*D - 2*F))
    + 0.010980 * Math.sin(toRad(Mp - 2*F))
    + 0.010675 * Math.sin(toRad(4*D - Mp))
    + 0.010034 * Math.sin(toRad(3*Mp))
    + 0.008548 * Math.sin(toRad(4*D - 2*Mp))
    - 0.007888 * E * Math.sin(toRad(2*D + M - Mp))
    - 0.006766 * E * Math.sin(toRad(2*D + M))
    - 0.005163 * Math.sin(toRad(D - Mp))
    + 0.004987 * E * Math.sin(toRad(D + M))
    + 0.004036 * E * Math.sin(toRad(2*D - M + Mp))
    + 0.003994 * Math.sin(toRad(2*Mp + 2*D))
    + 0.003665 * Math.sin(toRad(2*D - 3*Mp))
    - 0.002689 * E * Math.sin(toRad(M - 2*Mp))
    + 0.002390 * E * Math.sin(toRad(2*D - M - 2*Mp))
    + 0.002236 * E * Math.sin(toRad(2*D - 2*M))
    - 0.002120 * E * Math.sin(toRad(M + 2*Mp))
    + 0.001215 * Math.sin(toRad(4*D - M - Mp));
  return norm360(Lp + sig);
}

// ── Rahu (ascending node, ~0.1°) ─────────────────────────────────────────────
export function rahuLongitudeTropical(jd: number): number {
  const T = (jd - 2451545.0) / 36525;
  return norm360(125.04452 - 1934.136261 * T + 0.0020708 * T * T + T * T * T / 450000);
}

// ── Planetary Keplerian elements (JPL J2000.0) ────────────────────────────────
// Each row: [L0, L_rate, a0, a_rate, e0, e_rate, I0, I_rate, w0, w_rate, Om0, Om_rate]
const PLANET_ELEMENTS: Record<string, number[]> = {
  mercury: [252.25032350, 149472.67411175, 0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902,-0.00594749, 77.45779628, 0.16047689, 48.33076593,-0.12534081],
  venus:   [181.97909950,  58517.81538729, 0.72333566, 0.00000390, 0.00677672,-0.00004107, 3.39467605,-0.00078890,131.60246718, 0.00268329, 76.67984255,-0.27769418],
  earth:   [100.46457166,  35999.37244981, 1.00000261, 0.00000562, 0.01671123,-0.00004392,-0.00001531,-0.01294668,102.93768193, 0.32327364,  0.0,         0.0       ],
  mars:    [355.43299284,  19140.30268499, 1.52371034, 0.00001847, 0.09339410, 0.00007882, 1.84969142,-0.00813131,-23.94362959, 0.44441088, 49.55953891,-0.29257343],
  jupiter: [ 34.39644051,   3034.74612775, 5.20288700,-0.00011607, 0.04838624,-0.00013253, 1.30439695,-0.00183714, 14.72847983, 0.21252668,100.47390909, 0.20469106],
  saturn:  [ 49.95424423,   1222.49084773, 9.53667594,-0.00125060, 0.05386179,-0.00050991, 2.48599187, 0.00193609, 92.59887831,-0.41897216,113.66242448,-0.28867794],
};

function solveKepler(M: number, e: number): number {
  let E = M;
  for (let i = 0; i < 30; i++) {
    const dE = (M - E + e * Math.sin(E)) / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

function heliocentricXYZ(planet: string, T: number): [number, number, number] {
  const d = PLANET_ELEMENTS[planet];
  const L  = norm360(d[0]  + d[1]  * T);
  const a  = d[2]  + d[3]  * T;
  const e  = d[4]  + d[5]  * T;
  const I  = d[6]  + d[7]  * T;
  const w  = d[8]  + d[9]  * T;
  const Om = d[10] + d[11] * T;
  const M_mean = toRad(norm360(L - w));
  const E  = solveKepler(M_mean, e);
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const r  = a * (1 - e * Math.cos(E));
  const omega = toRad(w - Om);
  const u = nu + omega;
  const Om_r = toRad(Om); const I_r = toRad(I);
  return [
    r * (Math.cos(Om_r) * Math.cos(u) - Math.sin(Om_r) * Math.sin(u) * Math.cos(I_r)),
    r * (Math.sin(Om_r) * Math.cos(u) + Math.cos(Om_r) * Math.sin(u) * Math.cos(I_r)),
    r * Math.sin(u) * Math.sin(I_r),
  ];
}

function geocentricLongitude(planet: string, T: number): number {
  const [xp, yp] = heliocentricXYZ(planet, T);
  const [xe, ye] = heliocentricXYZ("earth", T);
  return norm360(toDeg(Math.atan2(yp - ye, xp - xe)));
}

// ── Ascendant ─────────────────────────────────────────────────────────────────
function gmstDeg(jd: number): number {
  const T = (jd - 2451545.0) / 36525;
  return norm360(280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000);
}

export function ascendantTropical(jd: number, latDeg: number, lonDeg: number): number {
  const T    = (jd - 2451545.0) / 36525;
  const LST  = norm360(gmstDeg(jd) + lonDeg);
  const eps  = toRad(23.4392911 - 0.013004167 * T);
  const RAMC = toRad(LST);
  const lat  = toRad(latDeg);
  const y    = -Math.cos(RAMC);
  const x    = Math.sin(eps) * Math.tan(lat) + Math.cos(eps) * Math.sin(RAMC);
  return norm360(toDeg(Math.atan2(y, x)));
}

// ── Rashis ────────────────────────────────────────────────────────────────────
export const RASHIS = [
  "Mesha (Aries)","Vrishabha (Taurus)","Mithuna (Gemini)","Karka (Cancer)",
  "Simha (Leo)","Kanya (Virgo)","Tula (Libra)","Vrischika (Scorpio)",
  "Dhanu (Sagittarius)","Makara (Capricorn)","Kumbha (Aquarius)","Meena (Pisces)",
];
export const RASHI_LORDS = ["Mars","Venus","Mercury","Moon","Sun","Mercury","Venus","Mars","Jupiter","Saturn","Saturn","Jupiter"];

export function getRashi(lon: number): string { return RASHIS[Math.floor(lon / 30)]; }
export function getRashiIndex(lon: number): number { return Math.floor(lon / 30); }
export function getDegInRashi(lon: number): number { return lon % 30; }

// ── Nakshatras ────────────────────────────────────────────────────────────────
export const NAKSHATRAS = [
  "Ashwini","Bharani","Krittika","Rohini","Mrigashira","Ardra",
  "Punarvasu","Pushya","Ashlesha","Magha","Purva Phalguni","Uttara Phalguni",
  "Hasta","Chitra","Swati","Vishakha","Anuradha","Jyeshtha",
  "Mula","Purva Ashadha","Uttara Ashadha","Shravana","Dhanishtha","Shatabhisha",
  "Purva Bhadrapada","Uttara Bhadrapada","Revati",
];

// Deep personality traits for each nakshatra (used in AI prompt)
export const NAKSHATRA_TRAITS: Record<string, { deity: string; symbol: string; nature: string; shadow: string; gift: string }> = {
  Ashwini:          { deity:"Ashwini Kumaras (divine healers)", symbol:"Horse's head", nature:"Swift, pioneering, healing energy. Natural go-getter, loves speed and new starts", shadow:"Impatient, can abandon things halfway", gift:"Ability to heal others and themselves remarkably fast" },
  Bharani:          { deity:"Yama (god of death & dharma)", symbol:"Yoni (womb)", nature:"Intensely creative and responsible. Carries heavy karmic weight. Deep sensuality", shadow:"Struggles with guilt, extremes, and feeling burdened", gift:"Extraordinary capacity to transform pain into creation" },
  Krittika:         { deity:"Agni (fire god)", symbol:"Razor/flame", nature:"Sharp, purifying, ambitious. Cuts through nonsense. Strong opinions and moral clarity", shadow:"Critical, harsh with self and others, burns bridges", gift:"Powerful ability to cut through illusion and see truth" },
  Rohini:           { deity:"Brahma (creator)", symbol:"Chariot, ox cart", nature:"Creative, sensual, magnetic. Attracted to beauty and abundance. Excellent taste", shadow:"Possessive, materialistic, can be stubborn", gift:"Natural magnetism — people are drawn to them without effort" },
  Mrigashira:       { deity:"Soma (moon god)", symbol:"Deer's head", nature:"Searching, gentle, curious. Always seeking something — love, knowledge, perfection", shadow:"Restless, never satisfied, can't settle", gift:"Beautiful mind — creative, sensitive, always growing" },
  Ardra:            { deity:"Rudra (storm god)", symbol:"Teardrop/diamond", nature:"Intense, transformative, emotionally raw. Often goes through storms to find clarity", shadow:"Destructive anger, emotional turbulence", gift:"After every storm, they rebuild better than before" },
  Punarvasu:        { deity:"Aditi (mother of gods)", symbol:"Quiver of arrows", nature:"Renewal, optimism, return. Often experiences loss then beautiful return. Philosophical", shadow:"Can be naive, too trusting, over-promises", gift:"Remarkable ability to bounce back — phoenix energy" },
  Pushya:           { deity:"Brihaspati (Jupiter/guru)", symbol:"Cow's udder", nature:"Nurturing, leadership through service, excellent teacher. Most auspicious nakshatra", shadow:"Can be overly paternalistic or self-righteous", gift:"Natural ability to nourish and support everyone around them" },
  Ashlesha:         { deity:"Nagas (serpent deities)", symbol:"Coiled serpent", nature:"Deep psychological insight, occult knowledge, sharp intuition. Penetrating gaze", shadow:"Manipulative, secretive, can cling and constrict", gift:"Extraordinary perception — can read people and situations like books" },
  Magha:            { deity:"Pitras (ancestors)", symbol:"Royal throne/palanquin", nature:"Regal, ancestral pride, leadership. Naturally authoritative, commands respect", shadow:"Arrogant, stuck in tradition, can't move forward", gift:"Royal presence — walks into a room and people notice" },
  "Purva Phalguni": { deity:"Bhaga (god of pleasure)", symbol:"Hammock/bed", nature:"Creative, pleasure-seeking, romantic. Loves art, music, beauty, rest", shadow:"Lazy, indulgent, can be self-absorbed", gift:"Natural artist — extraordinary ability to create joy for others" },
  "Uttara Phalguni":{ deity:"Aryaman (god of contracts)", symbol:"Bed with legs", nature:"Reliable, social, natural manager. Excellent in partnerships and marriage", shadow:"Dependent on others, struggles to be alone", gift:"Creates lasting, meaningful partnerships and social harmony" },
  Hasta:            { deity:"Savitar (solar deity)", symbol:"Hand", nature:"Clever, skilled, humorous. Exceptional manual dexterity and problem-solving", shadow:"Restless hands/mind, nervous energy, can be cunning", gift:"Master craftsperson of whatever they do — skill is extraordinary" },
  Chitra:           { deity:"Tvastar/Vishwakarma (divine architect)", symbol:"Bright jewel", nature:"Aesthetic perfection, artistic, magnetic. Creates beauty in all forms", shadow:"Vain, perfectionist to a fault, competitive", gift:"Eye for beauty that borders on divine — everything they create is beautiful" },
  Swati:            { deity:"Vayu (wind god)", symbol:"Coral/sword/young sprout", nature:"Independent, tactful, business-minded. Needs freedom like air", shadow:"Indecisive, scattered, influenced by others too easily", gift:"Adaptability and diplomacy — can handle any social situation" },
  Vishakha:         { deity:"Indra-Agni (power and fire)", symbol:"Triumphal arch/potter's wheel", nature:"Ambitious, goal-driven, patient. Willing to wait years for what they want", shadow:"Obsessive about goals, jealous, can be fanatical", gift:"Once they set a goal, NOTHING stops them. Unstoppable determination" },
  Anuradha:         { deity:"Mitra (god of friendship)", symbol:"Lotus/row of offerings", nature:"Devoted, loyal friend, spiritual. Finds success far from birthplace", shadow:"Secretive about suffering, takes on others' pain", gift:"Extraordinary friendship and loyalty — people would die for them" },
  Jyeshtha:         { deity:"Indra (king of gods)", symbol:"Circular amulet/umbrella", nature:"Chief, protective, eldest-energy. Natural leader and protector of others", shadow:"Melodramatic, jealous of younger ones, feels underappreciated", gift:"The person everyone calls in a crisis — natural protector and solver" },
  Mula:             { deity:"Nirriti (goddess of destruction/dissolution)", symbol:"Tied bunch of roots", nature:"Research, root-seeking, philosophy. Pulls things out by the root to find truth", shadow:"Self-destructive phases, uproots own happiness", gift:"Finds truth where no one else even thinks to look. Deep wisdom" },
  "Purva Ashadha":  { deity:"Apah (water goddesses)", symbol:"Elephant tusk/fan", nature:"Invincible, purifying, confident. Early victories come easily", shadow:"Overconfident, doesn't acknowledge defeat, stubborn", gift:"Resilience — they simply refuse to accept failure as final" },
  "Uttara Ashadha": { deity:"Vishwadevas (universal gods)", symbol:"Elephant tusk/plank bed", nature:"Ethical, righteous, takes responsibilities seriously. Late bloomer but lasting success", shadow:"Too serious, burdens self with others' problems", gift:"Long-lasting success that compounds over time — they build empires slowly" },
  Shravana:         { deity:"Vishnu (preserver)", symbol:"Three footprints/ear", nature:"Listening, learning, connecting. Exceptional memory and communication skills", shadow:"Gossip, over-analyzes, hears things that aren't there", gift:"Ability to listen so deeply that people feel completely understood" },
  Dhanishtha:       { deity:"Ashta Vasus (gods of abundance)", symbol:"Drum (mridanga)", nature:"Wealth, music, generosity. Naturally rhythmic and abundant", shadow:"Greedy, materialistic, or gives too much", gift:"Natural musician and generous soul — abundance flows through them" },
  Shatabhisha:      { deity:"Varuna (god of cosmic waters)", symbol:"Empty circle", nature:"Healing, secretive, scientific. 100 healers — they carry hidden knowledge", shadow:"Isolated, secretive to a fault, can feel alien to the world", gift:"Healing abilities that border on miraculous when they trust themselves" },
  "Purva Bhadrapada":{ deity:"Aja Ekapada (one-footed unborn god)", symbol:"Two-faced man/sword", nature:"Intense transformation, dual nature, fiery idealism", shadow:"Extreme mood swings, radical thinking, self-destructive", gift:"Can completely reinvent themselves — masters of transformation" },
  "Uttara Bhadrapada":{ deity:"Ahir Budhnya (serpent of the deep)", symbol:"Twins/back legs of funeral cot", nature:"Wisdom, depth, patience. The wisest energy in the zodiac when mature", shadow:"Too withdrawn, procrastinates, lives in their head", gift:"Wisdom so deep it seems to come from another life — ancient soul" },
  Revati:           { deity:"Pushan (nourisher, protector of travelers)", symbol:"Fish/drum", nature:"Nurturing, creative, compassionate. Guides others safely home", shadow:"Over-emotional, can get lost in others' suffering", gift:"Spiritual protection — they are always guided and always safe" },
};

export function getNakshatra(moonLon: number): string { return NAKSHATRAS[Math.floor(moonLon / (360 / 27))]; }
export function getNakshatraPada(moonLon: number): number { return Math.floor((moonLon % (360 / 27)) / (360 / 27 / 4)) + 1; }

// ── Planet Dignity ────────────────────────────────────────────────────────────
const EXALTATION_SIGN: Record<string, number>    = { Sun:0, Moon:1, Mars:9, Mercury:5, Jupiter:3, Venus:11, Saturn:6 };
const DEBILITATION_SIGN: Record<string, number>  = { Sun:6, Moon:7, Mars:3, Mercury:11, Jupiter:9, Venus:5, Saturn:0 };
const EXALTATION_DEG: Record<string, number>     = { Sun:10, Moon:3, Mars:28, Mercury:15, Jupiter:5, Venus:27, Saturn:20 };
const OWN_SIGNS: Record<string, number[]>        = {
  Sun:[4], Moon:[3], Mars:[0,7], Mercury:[5,2], Jupiter:[8,11], Venus:[1,6], Saturn:[9,10],
};

export type Dignity = "Exalted" | "Own Sign" | "Friend" | "Neutral" | "Enemy" | "Debilitated";

// Planetary friendships (temporary + permanent combined simplified)
const FRIENDS: Record<string, string[]>  = {
  Sun:["Moon","Mars","Jupiter"], Moon:["Sun","Mercury"], Mars:["Sun","Moon","Jupiter"],
  Mercury:["Sun","Venus"], Jupiter:["Sun","Moon","Mars"], Venus:["Mercury","Saturn"], Saturn:["Mercury","Venus"],
};
const ENEMIES: Record<string, string[]> = {
  Sun:["Venus","Saturn"], Moon:[], Mars:["Mercury"], Mercury:["Moon"],
  Jupiter:["Mercury","Venus"], Venus:["Sun","Moon"], Saturn:["Sun","Moon","Mars"],
};

export function getPlanetDignity(planet: string, rashiIndex: number): Dignity {
  if (!["Sun","Moon","Mars","Mercury","Jupiter","Venus","Saturn"].includes(planet)) return "Neutral";
  if (DEBILITATION_SIGN[planet] === rashiIndex) return "Debilitated";
  if (EXALTATION_SIGN[planet] === rashiIndex)   return "Exalted";
  if ((OWN_SIGNS[planet] ?? []).includes(rashiIndex)) return "Own Sign";
  const lord = RASHI_LORDS[rashiIndex];
  if ((FRIENDS[planet] ?? []).includes(lord))   return "Friend";
  if ((ENEMIES[planet] ?? []).includes(lord))   return "Enemy";
  return "Neutral";
}

export function getDignityStrength(d: Dignity): number {
  return { Exalted: 5, "Own Sign": 4, Friend: 3, Neutral: 2, Enemy: 1, Debilitated: 0 }[d] ?? 2;
}

// ── Yoga Detection ────────────────────────────────────────────────────────────
export interface Yoga {
  name: string;
  presentInChart: boolean;
  description: string;
  effect: string;
}

function isInKendra(fromRashiIdx: number, ofRashiIdx: number): boolean {
  const diff = (ofRashiIdx - fromRashiIdx + 12) % 12;
  return [0, 3, 6, 9].includes(diff);
}
function isInTrikona(fromRashiIdx: number, ofRashiIdx: number): boolean {
  const diff = (ofRashiIdx - fromRashiIdx + 12) % 12;
  return [0, 4, 8].includes(diff);
}
function isConjunct(a: number, b: number): boolean { return a === b; }

export function detectYogas(
  planets: Record<string, { rashiIndex: number; degInRashi: number; dignity: Dignity }>,
  lagnaIdx: number | null
): Yoga[] {
  const p = (name: string) => planets[name];
  const yogas: Yoga[] = [];

  // 1. Gaja Kesari — Moon and Jupiter in mutual kendra
  const gajaKesari = isInKendra(p("Moon").rashiIndex, p("Jupiter").rashiIndex);
  yogas.push({
    name: "Gaja Kesari Yoga",
    presentInChart: gajaKesari,
    description: "Moon and Jupiter in mutual kendra positions",
    effect: gajaKesari
      ? "✅ PRESENT — Powerful yoga for intelligence, fame, and leadership. This person has natural authority and is respected wherever they go. Financial stability and good reputation."
      : "❌ Absent",
  });

  // 2. Budh-Aditya — Sun and Mercury conjunct
  const budhAditya = isConjunct(p("Sun").rashiIndex, p("Mercury").rashiIndex);
  yogas.push({
    name: "Budh-Aditya Yoga",
    presentInChart: budhAditya,
    description: "Sun and Mercury in the same sign",
    effect: budhAditya
      ? "✅ PRESENT — Sharp intellect, excellent communication, success in education and business. The mind is brilliantly illuminated."
      : "❌ Absent",
  });

  // 3. Chandra-Mangala — Moon and Mars conjunct
  const chandraMangala = isConjunct(p("Moon").rashiIndex, p("Mars").rashiIndex);
  yogas.push({
    name: "Chandra-Mangala Yoga",
    presentInChart: chandraMangala,
    description: "Moon and Mars in the same sign",
    effect: chandraMangala
      ? "✅ PRESENT — Wealth through courage and emotional drive. Entrepreneurial spirit. Can earn well but must watch emotional impulsiveness with money."
      : "❌ Absent",
  });

  // 4. Hamsa (Pancha Mahapurusha) — Jupiter in kendra + own/exalted
  const hamsa = lagnaIdx !== null &&
    isInKendra(lagnaIdx, p("Jupiter").rashiIndex) &&
    (p("Jupiter").dignity === "Exalted" || p("Jupiter").dignity === "Own Sign");
  yogas.push({
    name: "Hamsa Yoga (Pancha Mahapurusha)",
    presentInChart: hamsa,
    description: "Jupiter exalted or in own sign in a kendra house",
    effect: hamsa
      ? "✅ PRESENT — One of the 5 great yogas. Wisdom, righteousness, spiritual grace. This person is naturally blessed and tends to guide others."
      : "❌ Absent",
  });

  // 5. Malavya (Pancha Mahapurusha) — Venus in kendra + own/exalted
  const malavya = lagnaIdx !== null &&
    isInKendra(lagnaIdx, p("Venus").rashiIndex) &&
    (p("Venus").dignity === "Exalted" || p("Venus").dignity === "Own Sign");
  yogas.push({
    name: "Malavya Yoga (Pancha Mahapurusha)",
    presentInChart: malavya,
    description: "Venus exalted or in own sign in a kendra house",
    effect: malavya
      ? "✅ PRESENT — Beauty, wealth, artistic talent, marital happiness. Strong sexual magnetism. Material abundance throughout life."
      : "❌ Absent",
  });

  // 6. Ruchaka (Pancha Mahapurusha) — Mars in kendra + own/exalted
  const ruchaka = lagnaIdx !== null &&
    isInKendra(lagnaIdx, p("Mars").rashiIndex) &&
    (p("Mars").dignity === "Exalted" || p("Mars").dignity === "Own Sign");
  yogas.push({
    name: "Ruchaka Yoga (Pancha Mahapurusha)",
    presentInChart: ruchaka,
    description: "Mars exalted or in own sign in a kendra house",
    effect: ruchaka
      ? "✅ PRESENT — Physical strength, leadership, military or police success. Fearless. Commands armies metaphorically — a born leader."
      : "❌ Absent",
  });

  // 7. Shasha (Pancha Mahapurusha) — Saturn in kendra + own/exalted
  const shasha = lagnaIdx !== null &&
    isInKendra(lagnaIdx, p("Saturn").rashiIndex) &&
    (p("Saturn").dignity === "Exalted" || p("Saturn").dignity === "Own Sign");
  yogas.push({
    name: "Shasha Yoga (Pancha Mahapurusha)",
    presentInChart: shasha,
    description: "Saturn exalted or in own sign in a kendra house",
    effect: shasha
      ? "✅ PRESENT — Longevity, discipline, political power, success in service/justice. This person rises slowly but reaches the top."
      : "❌ Absent",
  });

  // 8. Kemadruma Yoga (negative) — No planets in 2nd or 12th from Moon (isolation)
  const moonIdx = p("Moon").rashiIndex;
  const hasNeighbor = Object.entries(planets)
    .filter(([n]) => !["Moon","Rahu","Ketu"].includes(n))
    .some(([, pos]) => {
      const diff = (pos.rashiIndex - moonIdx + 12) % 12;
      return diff === 1 || diff === 11;
    });
  yogas.push({
    name: "Kemadruma Yoga",
    presentInChart: !hasNeighbor,
    description: "No planets flanking the Moon (2nd or 12th from Moon)",
    effect: !hasNeighbor
      ? "⚠️ PRESENT — Indicates periods of loneliness, isolation, or feeling misunderstood. Moon needs support. Can be counteracted by strong lagna or Jupiter aspect."
      : "✅ Absent — Moon has planetary company",
  });

  // 9. Saraswati Yoga — Jupiter, Venus, Mercury all in kendra/trikona
  const saraswati = lagnaIdx !== null && [p("Jupiter").rashiIndex, p("Venus").rashiIndex, p("Mercury").rashiIndex]
    .every(r => isInKendra(lagnaIdx, r) || isInTrikona(lagnaIdx, r));
  yogas.push({
    name: "Saraswati Yoga",
    presentInChart: saraswati,
    description: "Jupiter, Venus, Mercury all in kendra or trikona from lagna",
    effect: saraswati
      ? "✅ PRESENT — Extraordinary creative intelligence, artistic brilliance, academic excellence. A blessed mind."
      : "❌ Absent",
  });

  // 10. Dhana Yoga — 2nd and 11th lords connected
  // (simplified: Jupiter or Venus in 2nd or 11th house)
  const dhana = lagnaIdx !== null && [p("Jupiter").rashiIndex, p("Venus").rashiIndex].some(r => {
    const h = (r - lagnaIdx + 12) % 12;
    return h === 1 || h === 10; // 2nd or 11th house
  });
  yogas.push({
    name: "Dhana Yoga (Wealth)",
    presentInChart: dhana,
    description: "Wealth-giving planets in 2nd or 11th house",
    effect: dhana
      ? "✅ PRESENT — Strong potential for wealth accumulation. Financial success comes through hard work and wise investments."
      : "❌ Absent",
  });

  return yogas;
}

// ── Sade Sati & Dhaiyya ───────────────────────────────────────────────────────
export interface SadeSatiStatus {
  isSadeSati: boolean;
  isDhaiyya: boolean;
  phase: string;
  description: string;
}

export function checkSadeSati(natalMoonRashiIdx: number, currentSaturnRashiIdx: number): SadeSatiStatus {
  const diff = (currentSaturnRashiIdx - natalMoonRashiIdx + 12) % 12;
  if (diff === 11) return { isSadeSati: true, isDhaiyya: false, phase: "Rising Phase (1st phase)", description: "Saturn in 12th from natal Moon — Sade Sati has begun. Expenses up, sleep disturbed, confusion about direction. This phase is about internal restructuring. Lasts ~2.5 years." };
  if (diff === 0)  return { isSadeSati: true, isDhaiyya: false, phase: "Peak Phase (2nd phase)", description: "Saturn directly on natal Moon — the most intense Sade Sati phase. Challenges to health, relationships, career. Deep transformation happening. This is the crucible that creates gold. Lasts ~2.5 years." };
  if (diff === 1)  return { isSadeSati: true, isDhaiyya: false, phase: "Setting Phase (3rd phase)", description: "Saturn in 2nd from natal Moon — Sade Sati's final phase. Financial pressures, family tensions, but clarity returning. The worst is over. Lasts ~2.5 years." };
  if (diff === 4)  return { isSadeSati: false, isDhaiyya: true, phase: "Kantaka Shani / Dhaiyya", description: "Saturn in 4th from natal Moon — 2.5-year period affecting home, mother, peace of mind, property matters." };
  if (diff === 7)  return { isSadeSati: false, isDhaiyya: true, phase: "Ashtama Shani / Dhaiyya", description: "Saturn in 8th from natal Moon — 2.5-year period with obstacles, health issues, unexpected challenges. Requires extra caution." };
  return { isSadeSati: false, isDhaiyya: false, phase: "None", description: "Not running Sade Sati or Dhaiyya. Saturn's influence is relatively normal." };
}

// ── Current Transits ──────────────────────────────────────────────────────────
export interface TransitInfo {
  saturnCurrentRashi: string;
  saturnCurrentRashiIdx: number;
  jupiterCurrentRashi: string;
  jupiterCurrentRashiIdx: number;
  rahuCurrentRashi: string;
  ketuCurrentRashi: string;
  sadeSati: SadeSatiStatus;
  jupiterTransitNote: string;
}

export function getCurrentTransits(natalMoonRashiIdx: number): TransitInfo {
  const now = new Date();
  const jd  = julianDay(now.getFullYear(), now.getMonth() + 1, now.getDate(), 12);
  const T   = (jd - 2451545.0) / 36525;
  const aya = lahiriAyanamsha(jd);
  const toSid = (trop: number) => norm360(trop - aya);

  const satTrop  = geocentricLongitude("saturn",  T);
  const jupTrop  = geocentricLongitude("jupiter", T);
  const rahuTrop = rahuLongitudeTropical(jd);

  const satIdx  = getRashiIndex(toSid(satTrop));
  const jupIdx  = getRashiIndex(toSid(jupTrop));
  const rahuIdx = getRashiIndex(toSid(rahuTrop));
  const ketuIdx = (rahuIdx + 6) % 12;

  const sadeSati = checkSadeSati(natalMoonRashiIdx, satIdx);

  // Jupiter transit note
  const jupFromMoon = (jupIdx - natalMoonRashiIdx + 12) % 12;
  const jupNotes: Record<number, string> = {
    0: "Jupiter transiting natal Moon — extremely auspicious! New opportunities, blessings in relationships, expansion of life in positive ways",
    1: "Jupiter in 2nd from Moon — financial gains, family happiness, improved speech and communication",
    2: "Jupiter in 3rd from Moon — some challenges, needs effort. Good for short travel, siblings",
    3: "Jupiter in 4th from Moon — domestic happiness, property gain, inner peace",
    4: "Jupiter in 5th from Moon — excellent for children, creativity, romance, speculation gains",
    5: "Jupiter in 6th from Moon — health challenges possible, but victory over enemies. Service-oriented work flourishes",
    6: "Jupiter in 7th from Moon — marriage/partnership opportunities! Excellent for relationships",
    7: "Jupiter in 8th from Moon — Jupiter in 8th requires caution — research, inheritance, transformation themes",
    8: "Jupiter in 9th from Moon — highly auspicious! Luck, travel, spirituality, father's blessings",
    9: "Jupiter in 10th from Moon — career success, recognition, promotion likely",
    10:"Jupiter in 11th from Moon — fulfillment of desires, financial gains, friendships bloom",
    11:"Jupiter in 12th from Moon — spiritual seeking, foreign connections, some expenses",
  };

  return {
    saturnCurrentRashi: RASHIS[satIdx],
    saturnCurrentRashiIdx: satIdx,
    jupiterCurrentRashi: RASHIS[jupIdx],
    jupiterCurrentRashiIdx: jupIdx,
    rahuCurrentRashi: RASHIS[rahuIdx],
    ketuCurrentRashi: RASHIS[ketuIdx],
    sadeSati,
    jupiterTransitNote: jupNotes[jupFromMoon] ?? "Transit note unavailable",
  };
}

// ── Vimshottari Dasha ─────────────────────────────────────────────────────────
const NAKSHATRA_LORDS = ["Ketu","Venus","Sun","Moon","Mars","Rahu","Jupiter","Saturn","Mercury"];
const DASHA_YEARS     = { Ketu:7, Venus:20, Sun:6, Moon:10, Mars:7, Rahu:18, Jupiter:16, Saturn:19, Mercury:17 };
const DASHA_ORDER     = ["Ketu","Venus","Sun","Moon","Mars","Rahu","Jupiter","Saturn","Mercury"];

export function calculateDasha(moonLon: number, birthDate: Date): {
  currentDasha: string; currentAntardasha: string; dashaBalance: string;
  upcomingDashas: string;
} {
  const nakshatraIdx = Math.floor(moonLon / (360 / 27));
  const lordIdx = nakshatraIdx % 9;
  const startLord = NAKSHATRA_LORDS[lordIdx];
  const fractionComplete = (moonLon % (360 / 27)) / (360 / 27);

  const startDashaIdx = DASHA_ORDER.indexOf(startLord);
  const startDashaYears = DASHA_YEARS[startLord as keyof typeof DASHA_YEARS];
  const yearsElapsedAtBirth = fractionComplete * startDashaYears;

  type DashaEntry = { lord: string; start: Date; end: Date };
  const dashas: DashaEntry[] = [];
  let cursor = new Date(birthDate.getTime() - yearsElapsedAtBirth * 365.25 * 24 * 3600 * 1000);

  for (let i = 0; i < 20; i++) {
    const idx = (startDashaIdx + i) % 9;
    const lord = DASHA_ORDER[idx];
    const years = DASHA_YEARS[lord as keyof typeof DASHA_YEARS];
    const end = new Date(cursor.getTime() + years * 365.25 * 24 * 3600 * 1000);
    dashas.push({ lord, start: new Date(cursor), end });
    cursor = end;
  }

  const now = new Date();
  const currentIdx = dashas.findIndex(d => now >= d.start && now < d.end);
  const current = dashas[currentIdx] ?? dashas[0];
  const remaining = Math.max(0, (current.end.getTime() - now.getTime()) / (365.25 * 24 * 3600 * 1000));
  const dashaBalance = `${current.lord} Mahadasha — ${remaining.toFixed(1)} yrs left (ends ${current.end.getFullYear()})`;

  // Upcoming dashas (next 2)
  const upcoming = dashas.slice(currentIdx + 1, currentIdx + 3)
    .map(d => `${d.lord} (${d.start.getFullYear()}–${d.end.getFullYear()})`)
    .join(", ");

  // Antardasha
  const dashaYears = DASHA_YEARS[current.lord as keyof typeof DASHA_YEARS];
  const currentDashaIdx = DASHA_ORDER.indexOf(current.lord);
  const antardashas: DashaEntry[] = [];
  let aCursor = current.start;
  for (let i = 0; i < 9; i++) {
    const aLord = DASHA_ORDER[(currentDashaIdx + i) % 9];
    const aYears = (DASHA_YEARS[aLord as keyof typeof DASHA_YEARS] * dashaYears) / 120;
    const aEnd = new Date(aCursor.getTime() + aYears * 365.25 * 24 * 3600 * 1000);
    antardashas.push({ lord: aLord, start: new Date(aCursor), end: aEnd });
    aCursor = aEnd;
  }
  const currentAntar = antardashas.find(a => now >= a.start && now < a.end) ?? antardashas[0];

  return {
    currentDasha: current.lord,
    currentAntardasha: currentAntar.lord,
    dashaBalance,
    upcomingDashas: upcoming,
  };
}

// ── Planet karaka meanings ────────────────────────────────────────────────────
export const PLANET_KARAKAS: Record<string, string> = {
  Sun:     "Soul, father, authority, government, career status, health (heart/spine/eyes)",
  Moon:    "Mind, mother, emotions, public reputation, water, travel, lungs/chest/blood",
  Mars:    "Energy, courage, younger siblings, property, accidents, blood, muscles",
  Mercury: "Intelligence, communication, business, education, skin/nervous system",
  Jupiter: "Wisdom, husband (for women), children, wealth, spirituality, liver/fat",
  Venus:   "Love, wife (for men), beauty, arts, luxury, vehicles, kidneys/reproductive",
  Saturn:  "Karma, hard work, longevity, servants, delays, legs/bones/teeth",
  Rahu:    "Foreign elements, obsession, technology, unconventional paths, illusion",
  Ketu:    "Spirituality, past lives, detachment, sudden events, moksha, secret knowledge",
};

// ── Main KundaliData interface ────────────────────────────────────────────────
export interface PlanetPos {
  lon: number;
  rashi: string;
  rashiIndex: number;
  degInRashi: number;
  dignity: Dignity;
  dignityStrength: number;
}

export interface KundaliData {
  planets: Record<string, PlanetPos>;
  lagna:   PlanetPos | null;
  moonNakshatra: string;
  moonNakshatraPada: number;
  nakshatraTraits: typeof NAKSHATRA_TRAITS[string];
  ayanamsha: number;
  currentDasha: string;
  currentAntardasha: string;
  dashaBalance: string;
  upcomingDashas: string;
  yogas: Yoga[];
  activeYogas: Yoga[];
  transits: TransitInfo;
  strongestPlanets: string[];
  weakestPlanets: string[];
}

// ── Entry point ───────────────────────────────────────────────────────────────
export function calculateKundali(
  year: number, month: number, day: number,
  hourUT: number,
  latDeg: number | null,
  lonDeg: number | null,
  birthDate: Date,
): KundaliData {
  const jd  = julianDay(year, month, day, hourUT);
  const T   = (jd - 2451545.0) / 36525;
  const aya = lahiriAyanamsha(jd);
  const sid = (trop: number) => norm360(trop - aya);

  const rawLon: Record<string, number> = {
    Sun:     sid(sunLongitudeTropical(jd)),
    Moon:    sid(moonLongitudeTropical(jd)),
    Mercury: sid(geocentricLongitude("mercury", T)),
    Venus:   sid(geocentricLongitude("venus",   T)),
    Mars:    sid(geocentricLongitude("mars",    T)),
    Jupiter: sid(geocentricLongitude("jupiter", T)),
    Saturn:  sid(geocentricLongitude("saturn",  T)),
    Rahu:    sid(rahuLongitudeTropical(jd)),
    Ketu:    norm360(sid(rahuLongitudeTropical(jd)) + 180),
  };

  const planets: KundaliData["planets"] = {};
  for (const [name, lon] of Object.entries(rawLon)) {
    const ri = getRashiIndex(lon);
    const dig = getPlanetDignity(name, ri);
    planets[name] = { lon, rashi: getRashi(lon), rashiIndex: ri, degInRashi: getDegInRashi(lon), dignity: dig, dignityStrength: getDignityStrength(dig) };
  }

  let lagna: KundaliData["lagna"] = null;
  if (latDeg !== null && lonDeg !== null) {
    const ascLon = sid(ascendantTropical(jd, latDeg, lonDeg));
    const ri = getRashiIndex(ascLon);
    const dig = getPlanetDignity("Sun", ri); // placeholder
    lagna = { lon: ascLon, rashi: getRashi(ascLon), rashiIndex: ri, degInRashi: getDegInRashi(ascLon), dignity: dig, dignityStrength: 3 };
  }

  const moonSid = planets.Moon.lon;
  const nakshatra = getNakshatra(moonSid);
  const dasha = calculateDasha(moonSid, birthDate);
  const yogas = detectYogas(planets, lagna?.rashiIndex ?? null);
  const transits = getCurrentTransits(planets.Moon.rashiIndex);

  // Rank planets by strength
  const planetStrengths = Object.entries(planets)
    .filter(([n]) => !["Rahu","Ketu"].includes(n))
    .sort((a, b) => b[1].dignityStrength - a[1].dignityStrength);
  const strongestPlanets = planetStrengths.slice(0, 3).map(([n]) => n);
  const weakestPlanets   = planetStrengths.slice(-2).map(([n]) => n).reverse();

  return {
    planets, lagna,
    moonNakshatra: nakshatra,
    moonNakshatraPada: getNakshatraPada(moonSid),
    nakshatraTraits: NAKSHATRA_TRAITS[nakshatra] ?? NAKSHATRA_TRAITS["Ashwini"],
    ayanamsha: aya,
    currentDasha: dasha.currentDasha,
    currentAntardasha: dasha.currentAntardasha,
    dashaBalance: dasha.dashaBalance,
    upcomingDashas: dasha.upcomingDashas,
    yogas,
    activeYogas: yogas.filter(y => y.presentInChart),
    transits,
    strongestPlanets,
    weakestPlanets,
  };
}

// ── Rich context string for Groq ──────────────────────────────────────────────
export function buildKundaliContext(k: KundaliData, name: string, dob: string, pob: string): string {
  const lagnaIdx = k.lagna?.rashiIndex ?? 0;
  const houseOf  = (p: string) => k.lagna ? ((k.planets[p].rashiIndex - lagnaIdx + 12) % 12) + 1 : null;

  const planetLines = Object.entries(k.planets).map(([planet, pos]) => {
    const h = houseOf(planet);
    return `  ${planet.padEnd(9)}: ${pos.rashi} ${pos.degInRashi.toFixed(1)}° | ${pos.dignity.padEnd(11)} | ${h ? `House ${h}` : ""}`;
  }).join("\n");

  const activeYogaLines = k.activeYogas.length > 0
    ? k.activeYogas.map(y => `  • ${y.name}: ${y.effect.replace("✅ PRESENT — ","")}`).join("\n")
    : "  • No major yogas active";

  const nt = k.nakshatraTraits;
  const sadeSatiLine = k.transits.sadeSati.isSadeSati
    ? `⚠️ SADE SATI RUNNING — ${k.transits.sadeSati.phase}: ${k.transits.sadeSati.description}`
    : k.transits.sadeSati.isDhaiyya
    ? `⚠️ DHAIYYA/KANTAKA SHANI — ${k.transits.sadeSati.phase}: ${k.transits.sadeSati.description}`
    : "✅ Not in Sade Sati or Dhaiyya";

  return `
╔══════════════════════════════════════════════════════════════════╗
  VEDIC KUNDALI — ${name.toUpperCase()}
  Born: ${dob} | Place: ${pob}
  Ayanamsha (Lahiri): ${k.ayanamsha.toFixed(3)}°
╚══════════════════════════════════════════════════════════════════╝

PLANETARY POSITIONS (Sidereal):
${k.lagna ? `  Lagna (ASC): ${k.lagna.rashi} ${k.lagna.degInRashi.toFixed(1)}° | House 1\n` : "  Lagna: Unknown (birth time not provided)\n"}${planetLines}

PLANET DIGNITY SUMMARY:
  Strongest planets: ${k.strongestPlanets.join(", ")} (best placed, most beneficial)
  Weakest planets  : ${k.weakestPlanets.join(", ")} (need strengthening/care)

MOON NAKSHATRA ANALYSIS:
  Nakshatra: ${k.moonNakshatra} Pada ${k.moonNakshatraPada}
  Deity    : ${nt.deity}
  Symbol   : ${nt.symbol}
  Core nature: ${nt.nature}
  Hidden shadow: ${nt.shadow}
  Special gift : ${nt.gift}

ACTIVE YOGAS IN THIS CHART:
${activeYogaLines}

VIMSHOTTARI DASHA (Life timing system):
  Current: ${k.currentDasha} Mahadasha → ${k.currentAntardasha} Antardasha
  Status : ${k.dashaBalance}
  Next   : ${k.upcomingDashas}

CURRENT PLANETARY TRANSITS (affects life right now):
  Saturn transiting: ${k.transits.saturnCurrentRashi}
  Jupiter transiting: ${k.transits.jupiterCurrentRashi}
  Rahu transiting: ${k.transits.rahuCurrentRashi} | Ketu: ${k.transits.ketuCurrentRashi}
  ${sadeSatiLine}
  Jupiter transit effect: ${k.transits.jupiterTransitNote}
`.trim();
}

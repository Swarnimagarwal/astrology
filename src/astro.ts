// ── Vedic Kundali Calculator ──────────────────────────────────────────────────
// Implements accurate planetary position calculations using:
// - Jean Meeus "Astronomical Algorithms" for Sun & Moon
// - Keplerian orbital elements (JPL) for planets
// - Lahiri Ayanamsha for sidereal conversion
// - Vimshottari Dasha system

function toRad(d: number) { return d * Math.PI / 180; }
function toDeg(r: number) { return r * 180 / Math.PI; }
function norm360(a: number): number { a = a % 360; return a < 0 ? a + 360 : a; }

// ── Julian Day ─────────────────────────────────────────────────────────────────
export function julianDay(year: number, month: number, day: number, hourUT = 12): number {
  if (month <= 2) { year -= 1; month += 12; }
  const A = Math.floor(year / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + hourUT / 24 + B - 1524.5;
}

// ── Lahiri Ayanamsha ───────────────────────────────────────────────────────────
export function lahiriAyanamsha(jd: number): number {
  const T = (jd - 2451545.0) / 36525;
  return 23.85319 + 0.013964 * (T * 100); // degrees
}

// ── Sun Longitude (tropical, Meeus Ch.25, accurate ~0.01°) ───────────────────
export function sunLongitudeTropical(jd: number): number {
  const T = (jd - 2451545.0) / 36525;
  const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M  = norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const Mr = toRad(M);
  const C  = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr)
           + (0.019993 - 0.000101 * T) * Math.sin(2 * Mr)
           + 0.000289 * Math.sin(3 * Mr);
  const sunLon = norm360(L0 + C);
  // Apparent: correct for nutation and aberration (simplified)
  const Om = norm360(125.04452 - 1934.136261 * T);
  return norm360(sunLon - 0.00569 - 0.00478 * Math.sin(toRad(Om)));
}

// ── Moon Longitude (tropical, Meeus Ch.47 main terms, accurate ~0.3°) ─────────
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

// ── Rahu / North Node (accurate ~0.1°) ────────────────────────────────────────
export function rahuLongitudeTropical(jd: number): number {
  const T = (jd - 2451545.0) / 36525;
  return norm360(125.04452 - 1934.136261 * T + 0.0020708 * T * T + T * T * T / 450000);
}

// ── Keplerian orbital elements for planets (JPL, J2000.0) ─────────────────────
// [L0, L1_per_century, a0, a1, e0, e1, I0, I1, w0, w1, Om0, Om1]
const PLANET_ELEMENTS: Record<string, number[]> = {
  mercury: [252.25032350, 149472.67411175, 0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
  venus:   [181.97909950, 58517.81538729,  0.72333566, 0.00000390, 0.00677672,-0.00004107, 3.39467605, -0.00078890,131.60246718, 0.00268329, 76.67984255, -0.27769418],
  earth:   [100.46457166, 35999.37244981,  1.00000261, 0.00000562, 0.01671123,-0.00004392,-0.00001531, -0.01294668,102.93768193, 0.32327364,  0.0,          0.0       ],
  mars:    [355.43299284, 19140.30268499,  1.52371034, 0.00001847, 0.09339410, 0.00007882, 1.84969142, -0.00813131,-23.94362959, 0.44441088, 49.55953891, -0.29257343],
  jupiter: [34.39644051,   3034.74612775,  5.20288700,-0.00011607, 0.04838624,-0.00013253, 1.30439695, -0.00183714, 14.72847983, 0.21252668,100.47390909,  0.20469106],
  saturn:  [49.95424423,   1222.49084773,  9.53667594,-0.00125060, 0.05386179,-0.00050991, 2.48599187,  0.00193609, 92.59887831,-0.41897216,113.66242448, -0.28867794],
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
  const w  = d[8]  + d[9]  * T; // longitude of perihelion
  const Om = d[10] + d[11] * T; // longitude of ascending node

  const M_mean = toRad(norm360(L - w));
  const E = solveKepler(M_mean, e);
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const r  = a * (1 - e * Math.cos(E));

  const omega = toRad(w - Om); // argument of perihelion
  const u = nu + omega;
  const Om_r = toRad(Om);
  const I_r  = toRad(I);

  const x = r * (Math.cos(Om_r) * Math.cos(u) - Math.sin(Om_r) * Math.sin(u) * Math.cos(I_r));
  const y = r * (Math.sin(Om_r) * Math.cos(u) + Math.cos(Om_r) * Math.sin(u) * Math.cos(I_r));
  const z = r * Math.sin(u) * Math.sin(I_r);
  return [x, y, z];
}

function geocentricLongitude(planet: string, T: number): number {
  const [xp, yp, zp] = heliocentricXYZ(planet, T);
  const [xe, ye, ze] = heliocentricXYZ('earth', T);
  const dx = xp - xe, dy = yp - ye;
  return norm360(toDeg(Math.atan2(dy, dx)));
}

// ── Local Sidereal Time & Ascendant ────────────────────────────────────────────
function gmst(jd: number): number {
  const T = (jd - 2451545.0) / 36525;
  let g = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000;
  return norm360(g);
}

export function ascendantTropical(jd: number, latDeg: number, lonDeg: number): number {
  const T   = (jd - 2451545.0) / 36525;
  const LST = norm360(gmst(jd) + lonDeg);
  const eps = toRad(23.4392911 - 0.013004167 * T);
  const RAMC = toRad(LST);
  const lat  = toRad(latDeg);
  const y = -Math.cos(RAMC);
  const x = Math.sin(eps) * Math.tan(lat) + Math.cos(eps) * Math.sin(RAMC);
  return norm360(toDeg(Math.atan2(y, x)));
}

// ── Rashis & Nakshatras ────────────────────────────────────────────────────────
export const RASHIS = [
  "Mesha (Aries)","Vrishabha (Taurus)","Mithuna (Gemini)","Karka (Cancer)",
  "Simha (Leo)","Kanya (Virgo)","Tula (Libra)","Vrischika (Scorpio)",
  "Dhanu (Sagittarius)","Makara (Capricorn)","Kumbha (Aquarius)","Meena (Pisces)",
];

export const RASHI_LORDS = ["Mars","Venus","Mercury","Moon","Sun","Mercury","Venus","Mars","Jupiter","Saturn","Saturn","Jupiter"];

export const NAKSHATRAS = [
  "Ashwini","Bharani","Krittika","Rohini","Mrigashira","Ardra",
  "Punarvasu","Pushya","Ashlesha","Magha","Purva Phalguni","Uttara Phalguni",
  "Hasta","Chitra","Swati","Vishakha","Anuradha","Jyeshtha",
  "Mula","Purva Ashadha","Uttara Ashadha","Shravana","Dhanishtha","Shatabhisha",
  "Purva Bhadrapada","Uttara Bhadrapada","Revati",
];

// Nakshatra → Dasha lord
const NAKSHATRA_LORDS = ["Ketu","Venus","Sun","Moon","Mars","Rahu","Jupiter","Saturn","Mercury"];
const DASHA_YEARS     = { Ketu:7, Venus:20, Sun:6, Moon:10, Mars:7, Rahu:18, Jupiter:16, Saturn:19, Mercury:17 };
const DASHA_ORDER     = ["Ketu","Venus","Sun","Moon","Mars","Rahu","Jupiter","Saturn","Mercury"];

export function getRashi(lon: number): string { return RASHIS[Math.floor(lon / 30)]; }
export function getRashiIndex(lon: number): number { return Math.floor(lon / 30); }
export function getDegInRashi(lon: number): number { return lon % 30; }
export function getNakshatra(moonLon: number): string { return NAKSHATRAS[Math.floor(moonLon / (360/27))]; }
export function getNakshatraPada(moonLon: number): number { return Math.floor((moonLon % (360/27)) / (360/27/4)) + 1; }

// ── Vimshottari Dasha ──────────────────────────────────────────────────────────
export function calculateDasha(moonLon: number, birthDate: Date): { currentDasha: string; currentAntardasha: string; dashaBalance: string } {
  const nakshatraIndex = Math.floor(moonLon / (360 / 27));
  const lordIndex = nakshatraIndex % 9;
  const startLord = NAKSHATRA_LORDS[lordIndex];

  // How far through the nakshatra is the Moon (0–1)?
  const nakshatraSize = 360 / 27;
  const posInNakshatra = moonLon % nakshatraSize;
  const fractionComplete = posInNakshatra / nakshatraSize;

  const startDashaIdx = DASHA_ORDER.indexOf(startLord);
  const startDashaYears = DASHA_YEARS[startLord as keyof typeof DASHA_YEARS];
  const yearsElapsedAtBirth = fractionComplete * startDashaYears;

  // Build dasha timeline from birth
  type DashaEntry = { lord: string; start: Date; end: Date };
  const dashas: DashaEntry[] = [];
  let cursor = new Date(birthDate.getTime() - yearsElapsedAtBirth * 365.25 * 24 * 3600 * 1000);

  for (let i = 0; i < 18; i++) {
    const idx = (startDashaIdx + i) % 9;
    const lord = DASHA_ORDER[idx];
    const years = DASHA_YEARS[lord as keyof typeof DASHA_YEARS];
    const end = new Date(cursor.getTime() + years * 365.25 * 24 * 3600 * 1000);
    dashas.push({ lord, start: new Date(cursor), end });
    cursor = end;
  }

  const now = new Date();
  const current = dashas.find(d => now >= d.start && now < d.end) ?? dashas[0];
  const remaining = Math.max(0, (current.end.getTime() - now.getTime()) / (365.25 * 24 * 3600 * 1000));
  const dashaBalance = `${current.lord} Mahadasha (${remaining.toFixed(1)} years remaining until ${current.end.getFullYear()})`;

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
  };
}

// ── Planet descriptions ────────────────────────────────────────────────────────
export const PLANET_SIGNIFICATIONS: Record<string, string> = {
  Sun:     "soul, father, authority, career, health, ego, government",
  Moon:    "mind, mother, emotions, public, memory, water, travel",
  Mars:    "energy, courage, siblings, property, accidents, surgery, ambition",
  Mercury: "intelligence, communication, business, education, friends, skin",
  Jupiter: "wisdom, luck, marriage (for women), children, wealth, spirituality, expansion",
  Venus:   "love, marriage (for men), beauty, arts, luxury, vehicles, relationships",
  Saturn:  "discipline, karma, delays, hard work, servants, longevity, legs",
  Rahu:    "obsession, foreign lands, technology, unconventional paths, illusion, ambition",
  Ketu:    "spiritual liberation, past lives, detachment, mysticism, sudden events, accidents",
};

export const RASHI_NATURE: Record<string, string> = {
  "Mesha (Aries)":        "fire, movable, Mars-ruled — bold, impulsive, pioneering",
  "Vrishabha (Taurus)":   "earth, fixed, Venus-ruled — stable, sensual, determined",
  "Mithuna (Gemini)":     "air, dual, Mercury-ruled — communicative, versatile, curious",
  "Karka (Cancer)":       "water, movable, Moon-ruled — emotional, nurturing, intuitive",
  "Simha (Leo)":          "fire, fixed, Sun-ruled — royal, creative, authoritative",
  "Kanya (Virgo)":        "earth, dual, Mercury-ruled — analytical, service-oriented, perfectionistic",
  "Tula (Libra)":         "air, movable, Venus-ruled — balanced, diplomatic, artistic",
  "Vrischika (Scorpio)":  "water, fixed, Mars-ruled — intense, secretive, transformative",
  "Dhanu (Sagittarius)":  "fire, dual, Jupiter-ruled — philosophical, adventurous, optimistic",
  "Makara (Capricorn)":   "earth, movable, Saturn-ruled — disciplined, ambitious, practical",
  "Kumbha (Aquarius)":    "air, fixed, Saturn-ruled — humanitarian, unconventional, scientific",
  "Meena (Pisces)":       "water, dual, Jupiter-ruled — compassionate, spiritual, dreamy",
};

// ── Main kundali calculation entry point ──────────────────────────────────────
export interface KundaliData {
  planets: Record<string, { lon: number; rashi: string; rashiIndex: number; degInRashi: number }>;
  lagna:   { lon: number; rashi: string; rashiIndex: number; degInRashi: number } | null;
  moonNakshatra: string;
  moonNakshatraPada: number;
  ayanamsha: number;
  currentDasha: string;
  currentAntardasha: string;
  dashaBalance: string;
}

export function calculateKundali(
  year: number, month: number, day: number,
  hourUT: number,          // birth hour in UTC (use 12 if time unknown)
  latDeg: number | null,   // null if place unknown
  lonDeg: number | null,
  birthDate: Date,
): KundaliData {
  const jd  = julianDay(year, month, day, hourUT);
  const T   = (jd - 2451545.0) / 36525;
  const aya = lahiriAyanamsha(jd);

  const toSid = (tropLon: number) => norm360(tropLon - aya);

  // Tropical positions
  const sunTrop  = sunLongitudeTropical(jd);
  const moonTrop = moonLongitudeTropical(jd);
  const rahuTrop = rahuLongitudeTropical(jd);

  const mercuryTrop = geocentricLongitude("mercury", T);
  const venusTrop   = geocentricLongitude("venus",   T);
  const marsTrop    = geocentricLongitude("mars",    T);
  const jupiterTrop = geocentricLongitude("jupiter", T);
  const saturnTrop  = geocentricLongitude("saturn",  T);
  const ketuTrop    = norm360(rahuTrop + 180);

  // Convert to sidereal
  const raw: Record<string, number> = {
    Sun: toSid(sunTrop), Moon: toSid(moonTrop),
    Mercury: toSid(mercuryTrop), Venus: toSid(venusTrop),
    Mars: toSid(marsTrop), Jupiter: toSid(jupiterTrop),
    Saturn: toSid(saturnTrop), Rahu: toSid(rahuTrop), Ketu: toSid(ketuTrop),
  };

  const planets: KundaliData["planets"] = {};
  for (const [name, lon] of Object.entries(raw)) {
    planets[name] = {
      lon, rashi: getRashi(lon), rashiIndex: getRashiIndex(lon), degInRashi: getDegInRashi(lon),
    };
  }

  // Ascendant
  let lagna: KundaliData["lagna"] = null;
  if (latDeg !== null && lonDeg !== null) {
    const ascTrop = ascendantTropical(jd, latDeg, lonDeg);
    const ascSid  = toSid(ascTrop);
    lagna = { lon: ascSid, rashi: getRashi(ascSid), rashiIndex: getRashiIndex(ascSid), degInRashi: getDegInRashi(ascSid) };
  }

  const moonSid = planets.Moon.lon;
  const dasha = calculateDasha(moonSid, birthDate);

  return {
    planets,
    lagna,
    moonNakshatra: getNakshatra(moonSid),
    moonNakshatraPada: getNakshatraPada(moonSid),
    ayanamsha: aya,
    ...dasha,
  };
}

// ── Build Groq context string ──────────────────────────────────────────────────
export function buildKundaliContext(k: KundaliData, name: string, dob: string, pob: string): string {
  const planetLines = Object.entries(k.planets).map(([planet, pos]) =>
    `  ${planet}: ${pos.rashi} at ${pos.degInRashi.toFixed(1)}° — ${PLANET_SIGNIFICATIONS[planet] ?? ""}`
  ).join("\n");

  const lagnaLine = k.lagna
    ? `  Lagna (Ascendant): ${k.lagna.rashi} at ${k.lagna.degInRashi.toFixed(1)}° — sets the entire life frame`
    : `  Lagna: Not calculated (birth time unknown — analysis based on planets only)`;

  return `
KUNDALI OF: ${name}
Born: ${dob} | Place: ${pob}
Ayanamsha (Lahiri): ${k.ayanamsha.toFixed(4)}°

PLANETARY POSITIONS (Sidereal / Vedic):
${lagnaLine}
${planetLines}

MOON NAKSHATRA: ${k.moonNakshatra}, Pada ${k.moonNakshatraPada}

CURRENT DASHA SYSTEM (Vimshottari):
  Running Mahadasha: ${k.currentDasha}
  Running Antardasha: ${k.currentAntardasha}
  ${k.dashaBalance}

HOUSE PLACEMENTS (Whole Sign from Lagna):
${k.lagna ? Object.entries(k.planets).map(([planet, pos]) => {
  const houseNum = ((pos.rashiIndex - k.lagna!.rashiIndex + 12) % 12) + 1;
  return `  ${planet} in House ${houseNum}`;
}).join("\n") : "  (Lagna unknown — houses not calculated)"}
`.trim();
}

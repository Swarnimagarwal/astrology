import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 10,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS astro_users (
      id            BIGINT PRIMARY KEY,
      first_name    TEXT,
      name          TEXT,
      dob_year      INT,
      dob_month     INT,
      dob_day       INT,
      tob_hour      FLOAT,        -- birth hour in UTC, NULL if unknown
      pob           TEXT,         -- place of birth string
      lat           FLOAT,        -- geocoded latitude
      lon           FLOAT,        -- geocoded longitude
      state         TEXT NOT NULL DEFAULT 'idle',
      has_paid      BOOLEAN NOT NULL DEFAULT false,
      premium_plan  TEXT,
      premium_expires_at TIMESTAMPTZ,
      chat_history  JSONB NOT NULL DEFAULT '[]',
      trial_started_at TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS astro_users_state ON astro_users(state);
    CREATE INDEX IF NOT EXISTS astro_users_paid  ON astro_users(has_paid);
  `);
}

export type User = {
  id: number;
  first_name: string | null;
  name: string | null;
  dob_year: number | null;
  dob_month: number | null;
  dob_day: number | null;
  tob_hour: number | null;
  pob: string | null;
  lat: number | null;
  lon: number | null;
  state: string;
  has_paid: boolean;
  premium_plan: string | null;
  premium_expires_at: Date | null;
  chat_history: { role: string; content: string }[];
  trial_started_at: Date | null;
};

export async function getUser(id: number): Promise<User | null> {
  const { rows } = await pool.query("SELECT * FROM astro_users WHERE id=$1", [id]);
  return rows[0] ?? null;
}

export async function upsertUser(id: number, first_name: string, fields: Partial<Omit<User, "id">> = {}) {
  const user = await getUser(id);
  if (!user) {
    await pool.query(
      `INSERT INTO astro_users (id, first_name, state) VALUES ($1,$2,'setup_name')`,
      [id, first_name]
    );
    return getUser(id) as Promise<User>;
  }
  if (Object.keys(fields).length === 0) return user;

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k}=$${i++}`);
    vals.push(v);
  }
  sets.push(`updated_at=NOW()`);
  vals.push(id);
  await pool.query(`UPDATE astro_users SET ${sets.join(",")} WHERE id=$${i}`, vals);
  return getUser(id) as Promise<User>;
}

export async function checkPremiumExpiry(user: User) {
  if (user.has_paid && user.premium_expires_at && new Date() > user.premium_expires_at) {
    await pool.query(`UPDATE astro_users SET has_paid=false, premium_plan=NULL, premium_expires_at=NULL WHERE id=$1`, [user.id]);
    return { ...user, has_paid: false, premium_plan: null, premium_expires_at: null };
  }
  return user;
}

export async function addChatMessage(id: number, role: string, content: string) {
  await pool.query(
    `UPDATE astro_users SET chat_history = chat_history || $1::jsonb, updated_at=NOW() WHERE id=$2`,
    [JSON.stringify([{ role, content }]), id]
  );
}

export async function clearChatHistory(id: number) {
  await pool.query(`UPDATE astro_users SET chat_history='[]', updated_at=NOW() WHERE id=$1`, [id]);
}

export async function countUsers(): Promise<{ total: number; paid: number; today: number }> {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                                             AS total,
      COUNT(*) FILTER (WHERE has_paid)                                     AS paid,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')       AS today
    FROM astro_users
  `);
  return { total: Number(rows[0].total), paid: Number(rows[0].paid), today: Number(rows[0].today) };
}

export async function getUnpaidActiveUsers(): Promise<{ id: number }[]> {
  const { rows } = await pool.query(
    `SELECT id FROM astro_users WHERE has_paid=false AND dob_year IS NOT NULL AND id!=$1`,
    [Number(process.env.ADMIN_TELEGRAM_ID ?? 0)]
  );
  return rows;
}

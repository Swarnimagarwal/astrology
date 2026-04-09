import http from "http";
import { initDb } from "./db.js";
import { startBot } from "./bot.js";

const PORT = Number(process.env.PORT ?? 8080);

async function main() {
  console.log("🔮 AstroBot starting...");

  await initDb();
  console.log("✅ Database ready");

  startBot();

  // Health check HTTP server (required for Railway / Koyeb)
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", bot: "AstroBot", time: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(PORT, () => console.log(`✅ Health server on :${PORT}`));
}

main().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

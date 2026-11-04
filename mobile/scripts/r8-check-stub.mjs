// A server that only knows sign-in, for scripts/r8-check.sh. Everything else is a
// 404, which the app already has to cope with from an older server, so the screens
// after sign-in show their own error states. What's being tested is the native side
// under R8, not the data.
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8788);

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  console.log(`${req.method} ${path}`);
  if (req.method === "POST" && path === "/api/auth/login") {
    send(res, 200, { success: true, token: "r8-check-stub-token" });
  } else if (path === "/api/auth/session") {
    send(res, 200, {
      authenticated: req.headers.authorization === "Bearer r8-check-stub-token",
      method: "account",
      userId: "r8-check",
      encryptionLocked: false,
      onboardingComplete: true,
      displayCurrency: "USD",
    });
  } else {
    send(res, 404, { error: "Not in the R8 check's stub server" });
  }
}).listen(PORT, "0.0.0.0", () => console.log(`stub listening on ${PORT}`));

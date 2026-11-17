import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import intakeRouter from "./intake/routes";
import downloadsRouter from "./routes/downloads";
import tracerRouter from "./intake/tracer";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const app: Express = express();
// Trust X-Forwarded-* only from proxies you configure (DATACAT_TRUST_PROXY, e.g. 1 for one reverse proxy in front).
const trustProxy = (process.env.DATACAT_TRUST_PROXY ?? "").trim();
app.set(
  "trust proxy",
  !trustProxy || trustProxy === "false"
    ? false
    : trustProxy === "true"
      ? true
      : /^\d+$/.test(trustProxy)
        ? Number(trustProxy)
        : trustProxy.split(",").map((x) => x.trim()),
);

app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) =>
        /\/(api\/v[0-9.]+\/(series|traces|logs|check_run|stats)|api\/beta\/sketches|intake|v0\.[0-9]\/|dogstatsd|telemetry|info$)/.test(req.url ?? ""),
    },
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0]?.replace(/(\/(?:invite|invites|agent|input)\/)[^/]+/gi, "$1[redacted]") };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
// DataCat is never embedded in another page.
app.use((_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  next();
});
app.use(cors());
// Agent intake routes take raw (possibly compressed / protobuf) bodies, so they mount before JSON parsing.
app.use(intakeRouter);
app.use(downloadsRouter);
app.use(tracerRouter);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.SESSION_SECRET));
app.use("/api", authMiddleware, router);

// Resolve relative to the bundle, not the invoking shell's working directory.
const uiDir = process.env.DATACAT_UI_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(path.join(uiDir, "index.html"))) {
  app.use(express.static(uiDir));
  app.get("/{*path}", (req, res, next) => {
    if (/^\/(api|otlp|downloads|intake|v[0-9])(?:\/|$)/.test(req.path)) {
      next();
      return;
    }
    res.sendFile(path.join(uiDir, "index.html"));
  });
}
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, "Request failed");
  res.status(500).json({ error: "An internal error occurred. Check the server logs." });
});

export default app;

import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import telemetryPg from "./telemetry";
import telemetryCh from "./telemetryCh";
import { useClickHouse } from "../lib/storage";
import resourcesRouter from "./resources";
import mcpRouter from "./mcp";
import mcpTokensRouter from "./mcpTokens";

const router: IRouter = Router();
router.use(healthRouter);
router.use(authRouter);
// Telemetry reads (logs, APM, metrics, hosts) for the storage chosen by DATACAT_STORAGE; both serve the same API.
router.use(useClickHouse ? telemetryCh : telemetryPg);
router.use(resourcesRouter);
// Personal MCP tokens of the signed-in user, and the MCP server for AI assistants (MCP token or key pair only).
router.use(mcpTokensRouter);
router.use(mcpRouter);

export default router;

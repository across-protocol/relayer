import app from "./app";
import { Logger } from "./utils/logger";

const PORT = parseInt(process.env.PORT || "8080", 10);

process.on("uncaughtException", (error) => {
  Logger.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  Logger.error("Unhandled Rejection at:", { reason, promise });
  process.exit(1);
});

app.listen(PORT, "0.0.0.0", () => {
  Logger.info(`Server is running on port ${PORT}`);
  Logger.info(`Health check available at http://localhost:${PORT}/health`);
  Logger.info("Environment variables check:", {
    PRIVATE_KEY: process.env.PRIVATE_KEY ? "Set" : "Missing",
    ETHEREUM_RPC_URL: process.env.ETHEREUM_RPC_URL ? "Set" : "Missing",
    OPTIMISM_RPC_URL: process.env.OPTIMISM_RPC_URL ? "Set" : "Missing",
    ARBITRUM_RPC_URL: process.env.ARBITRUM_RPC_URL ? "Set" : "Missing",
    POLYGON_RPC_URL: process.env.POLYGON_RPC_URL ? "Set" : "Missing",
    BASE_RPC_URL: process.env.BASE_RPC_URL ? "Set" : "Missing",
  });
});

import app from "./app";
import { winston } from "../utils";

const PORT = parseInt(process.env.PORT || "8080", 10);

// Create logger instance
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

process.on("uncaughtException", (error) => {
  logger.error({ at: "CCTPFinalizer#uncaughtException", message: "Uncaught Exception", error });
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error({ at: "CCTPFinalizer#unhandledRejection", message: "Unhandled Rejection", reason, promise });
  process.exit(1);
});

app.listen(PORT, "0.0.0.0", () => {
  logger.info({ at: "CCTPFinalizer#startup", message: `Server is running on port ${PORT}` });
  logger.info({ at: "CCTPFinalizer#startup", message: `Health check available at http://localhost:${PORT}/health` });
});

// eslint-disable-next-line node/no-extraneous-import -- express is a transitive dependency from @uma/serverless-orchestration
import express, { Request, Response } from "express";
import { CCTPService } from "./services/cctpService";
import { winston } from "../utils";
import { PubSubMessage } from "./types";

const app = express();

// Create logger instance
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

let cctpService: CCTPService;

try {
  cctpService = new CCTPService(logger);
  logger.info({ at: "CCTPFinalizer#init", message: "Application initialized successfully" });
} catch (error) {
  logger.error({ at: "CCTPFinalizer#init", message: "Failed to initialize application", error });
  // eslint-disable-next-line no-process-exit -- Initialization failure is fatal, app cannot function
  process.exit(1);
}

app.use(express.json());

app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

app.post("/", async (req: Request, res: Response) => {
  try {
    const pubSubMessage = req.body.message;

    if (!pubSubMessage) {
      logger.error({ at: "CCTPFinalizer#processMessage", message: "Invalid Pub/Sub message format" });
      res.status(400).send("Bad Request: Invalid Pub/Sub message format");
      return;
    }

    const data = Buffer.from(pubSubMessage.data, "base64").toString().trim();
    logger.info({
      at: "CCTPFinalizer#processMessage",
      message: "Received Pub/Sub message",
      data,
      attributes: pubSubMessage.attributes,
    });

    const shouldRetry = await processMessage(data, pubSubMessage.attributes);

    if (shouldRetry) {
      res.status(500).send("Internal Server Error");
      return;
    }

    res.status(204).send();
  } catch (error) {
    logger.error({ at: "CCTPFinalizer#processMessage", message: "Error processing message", error });
    res.status(500).send("Internal Server Error");
  }
});

async function processMessage(data: string, attributes?: { [key: string]: string }): Promise<boolean> {
  try {
    const messageData: PubSubMessage = JSON.parse(data);

    logger.info({
      at: "CCTPFinalizer#processMessage",
      message: "Processing CCTP burn transaction",
      burnTransactionHash: messageData.burnTransactionHash,
      sourceChainId: messageData.sourceChainId,
      attributes: attributes || {},
    });

    const response = await cctpService.processBurnTransaction(messageData);

    if (response.success) {
      logger.info({
        at: "CCTPFinalizer#processMessage",
        message: "Burn transaction processed successfully",
        mintTxHash: response.mintTxHash,
        burnTransactionHash: messageData.burnTransactionHash,
      });
      return false;
    } else {
      logger.error({
        at: "CCTPFinalizer#processMessage",
        message: "Burn transaction processing failed",
        error: response.error,
        burnTransactionHash: messageData.burnTransactionHash,
      });
      return response.shouldRetry ?? true;
    }
  } catch (parseError) {
    logger.error({ at: "CCTPFinalizer#processMessage", message: "Error parsing message data", error: parseError });
    throw parseError;
  }
}

export default app;

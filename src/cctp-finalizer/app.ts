import express, { Request, Response } from "express";
import { CCTPService } from "./services/cctpService";
import { Logger } from "./utils/logger";
import { validateEnvironmentVariables } from "./config/chains";
import { PubSubMessage } from "./types";

const app = express();

let cctpService: CCTPService;

try {
  validateEnvironmentVariables();
  cctpService = new CCTPService(true);
  Logger.info("Application initialized successfully");
} catch (error) {
  Logger.error("Failed to initialize application:", error);
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
      Logger.error("Invalid Pub/Sub message format");
      res.status(400).send("Bad Request: Invalid Pub/Sub message format");
      return;
    }

    const data = Buffer.from(pubSubMessage.data, "base64").toString().trim();
    Logger.info("Received Pub/Sub message", { data, attributes: pubSubMessage.attributes });

    await processMessage(data, pubSubMessage.attributes);

    res.status(204).send();
  } catch (error) {
    Logger.error("Error processing message:", error);
    res.status(500).send("Internal Server Error");
  }
});

async function processMessage(data: string, attributes?: { [key: string]: string }): Promise<void> {
  try {
    const messageData: PubSubMessage = JSON.parse(data);

    Logger.info("Processing CCTP burn transaction", {
      burnTransactionHash: messageData.burnTransactionHash,
      sourceChainId: messageData.sourceChainId,
      attributes: attributes || {},
    });

    const response = await cctpService.processBurnTransaction(messageData);

    if (response.success) {
      Logger.info("Burn transaction processed successfully", {
        mintTxHash: response.mintTxHash,
        burnTransactionHash: messageData.burnTransactionHash,
      });
    } else {
      Logger.error("Burn transaction processing failed", {
        error: response.error,
        burnTransactionHash: messageData.burnTransactionHash,
      });
    }
  } catch (parseError) {
    Logger.error("Error parsing message data:", parseError);
    throw parseError;
  }
}

export default app;

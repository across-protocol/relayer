import { clients } from "@across-protocol/sdk";

export type SpokePoolClient = clients.SpokePoolClient;
export type SpokePoolUpdate = clients.SpokePoolUpdate;
export const { SpokePoolClient } = clients;

export { IndexedSpokePoolClient, SpokePoolClientMessage } from "./SpokePoolClient";
export class BundleDataClient extends clients.BundleDataClient.BundleDataClient {}

export * from "./BalanceAllocator";
export * from "./HubPoolClient";
export * from "./ConfigStoreClient";
export * from "./MultiCallerClient";
export * from "./ProfitClient";
export * from "./TokenClient";
export * from "./TokenTransferClient";
export * from "./TransactionClient";
export * from "./InventoryClient";
export * from "./AcrossAPIClient";

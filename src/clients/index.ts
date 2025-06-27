import { clients } from "@across-protocol/sdk";

export type SpokePoolClient = clients.SpokePoolClient;
export type EVMSpokePoolClient = clients.EVMSpokePoolClient;
export type SVMSpokePoolClient = clients.SVMSpokePoolClient;
export type SpokePoolUpdate = clients.SpokePoolUpdate;
export const { EVMSpokePoolClient, SpokePoolClient, SVMSpokePoolClient } = clients;

export { SpokeListener, SpokePoolClientMessage } from "./SpokePoolClient";
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

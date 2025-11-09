import { clients } from "@across-protocol/sdk";

export type SpokePoolManager = clients.SpokePoolManager;
export type SpokePoolClient = clients.SpokePoolClient;
export type EVMSpokePoolClient = clients.EVMSpokePoolClient;
export type SVMSpokePoolClient = clients.SVMSpokePoolClient;
export type SpokePoolUpdate = clients.SpokePoolUpdate;
export const { EVMSpokePoolClient, SpokePoolClient, SVMSpokePoolClient, SpokePoolManager } = clients;

export { SpokeListener } from "./SpokePoolClient";
export class BundleDataClient extends clients.BundleDataClient.BundleDataClient {}

export * from "./BalanceAllocator";
export * from "./EventListener";
export * from "./HubPoolClient";
export * from "./ConfigStoreClient";
export * from "./MultiCallerClient";
export * from "./ProfitClient";
export * from "./TokenClient";
export * from "./TokenTransferClient";
export * from "./TransactionClient";
export * from "./InventoryClient";
export * from "./AcrossAPIClient";
export * from "./SvmFillerClient";
export * from "./BundleDataApproxClient";
export * from "./AcrossSwapApiClient";

import { SpokePoolClient } from "../clients";

export interface SpokePoolClientsByChain {
  [chainId: number]: SpokePoolClient;
}

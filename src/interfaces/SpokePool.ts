import { interfaces } from "@across-protocol/sdk-v2";
import { SpokePoolClient } from "../clients";
import * as utils from "../utils/SDKUtils";

export interface SpokePoolClientsByChain {
  [chainId: number]: SpokePoolClient;
}

export const { InvalidFill } = utils;

export type InvalidFill = {
  fill: interfaces.FillWithBlock;
  code: utils.InvalidFillEnum;
  reason: string;
};

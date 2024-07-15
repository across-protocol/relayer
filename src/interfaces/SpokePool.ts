import { FillWithBlock, SpokePoolClient } from "../clients";
import * as utils from "../utils/SDKUtils";

export interface SpokePoolClientsByChain {
  [chainId: number]: SpokePoolClient;
}

export const { InvalidFill } = utils;

export type InvalidFill = {
  fill: FillWithBlock;
  code: utils.InvalidFillEnum;
  reason: string;
};

import winston from "winston";

export class MulticallBundler {
  constructor(readonly logger: winston.Logger, readonly gasEstimator: any) {}
}

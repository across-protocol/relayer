export type EthersError = Error & {
  code: string;
  reason: string;
};

export function usage(badInput: string = undefined) {
  let usageStr = badInput ? `\nUnrecognized input: "${badInput}".\n\n` : "";
  const userModes = "monitor|relayer";
  const proModes = "dataworker|finalizer";
  const walletOpts = "mnemonic|privateKey|gckms";

  usageStr += `
    Usage:
    \tts-node ./index.ts --help
    \tts-node ./index.ts [-h] <--monitor|--relayer>      --wallet <${walletOpts}>
    \tts-node ./index.tx [-h] <--dataworker|--finalizer> --wallet <${walletOpts}>
  `.slice(1);

  console.log(usageStr);

  // eslint-disable-next-line no-process-exit
  process.exit(badInput === undefined ? 0 : 9);
}

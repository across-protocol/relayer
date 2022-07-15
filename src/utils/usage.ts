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

export function help() {
  const botRepoUrl = "https://github.com/across-protocol/relayer-v2";
  const relayerDocsUrl = "https://docs.across.to/v2/developers/running-a-relayer";
  const helpStr = `
    Across v2 Bot

    Description:
    \tThis application performs off-chain duties in support of the Across v2 bridge.

    \tBasic sub-functions include:
    \t  Monitor:    Monitor all relay and bundle events.
    \t  Relayer:    Perform transaction relays based on eligible SpokePool deposits.

    \tAdvanced sub-functions include:
    \t  Dataworker: Monitor and produce relay bundles for the Hub Pool.
    \t  Finalizer:  Finalize and collect canonical bridge transfers.

    Links:
    \tRepository: ${botRepoUrl}
    \tRelayer Instructions: ${relayerDocsUrl}
  `.slice(0, -1);

  console.log(helpStr);
  usage(); // no return
}

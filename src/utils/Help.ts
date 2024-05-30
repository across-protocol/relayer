export function usage(badInput: string | undefined = undefined): boolean {
  let usageStr = badInput ? `\nUnrecognized input: "${badInput}".\n\n` : "";
  const walletTypes = "secret|mnemonic|privateKey|gckms|void";
  const walletUsage = `--wallet <${walletTypes}> | --wallet void [--address <ro-address>]`;

  usageStr += `
    Usage:
    \tnode ./dist/index.js --help
    \tnode ./dist/index.js [-h] <--monitor|--relayer>      [${walletUsage}]
    \tnode ./dist/index.js [-h] <--dataworker|--finalizer> [${walletUsage}]
  `.slice(1); // Skip leading newline

  // eslint-disable-next-line no-console
  console.log(usageStr);

  // eslint-disable-next-line no-process-exit
  process.exit(badInput === undefined ? 0 : 9);
}

export function help(): void {
  const botRepoUrl = "https://github.com/across-protocol/relayer-v3";
  const relayerDocsUrl = "https://docs.across.to/v2/developers/running-a-relayer";
  const helpStr = `
    Across v2 Bot

    Description:
    \tThis application performs various duties in support of the Across v2
    \tecosystem. The application implements four key functionalities, divided
    \tcoarsely between *Basic* and *Advanced* use cases.

    \tBasic functionalities are designed for widespread use. These include:

    \t  Monitor:    Monitor and report on all relay and bundle events.
    \t  Relayer:    Perform transaction relays for eligible SpokePool deposits.

    \tOperating a relayer can be a profitable activity and helps to improve the
    \tspeed and reliability of Across for its users. Note that as with any
    \tautomated operations involving funds, operating a relayer implies some
    \tunavoidable level of operational risk. Loss of funds is a possibility.
    \tBefore operating a relayer, please research and understand the implicit
    \trisks associated, and ensure this is compatible with your risk profile.

    \tAdvanced functionalities implement the heavy lifting that is required to
    \tkeep Across operating. These include:

    \t  Dataworker: Monitor and produce relay bundles for the Hub Pool.
    \t  Finalizer:  Finalize and collect canonical bridge transfers.

    \tRunning a dataworker or finalizer is predominantly a benevolent activity
    \tthat will typically not generate a direct profit. Advanced functionalities
    \tare intended for use for key Across ecosystem stakeholders, rather than
    \tindividuals.

    Links:
    \tRepository: ${botRepoUrl}
    \tRelayer Instructions: ${relayerDocsUrl}
  `.slice(0, -1); // Skip trailing newline

  // eslint-disable-next-line no-console
  console.log(helpStr);
  usage(); // no return
}

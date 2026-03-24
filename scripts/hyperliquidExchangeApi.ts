import * as hl from "@nktkas/hyperliquid";
import { SymbolConverter } from "@nktkas/hyperliquid/script/src/utils/mod";

async function run() {
  const subsClient = new hl.SubscriptionClient({
    transport: new hl.WebSocketTransport(),
  });

  const httpTransport = new hl.HttpTransport(); // or `WebSocketTransport`
  const converter = await SymbolConverter.create({ transport: httpTransport });
  const spotPairId = converter.getSpotPairId("USDT0/USDC");
  console.log(`Printing fills for spot pair ${spotPairId}`);
  // Log out all historical fills for user and also log
  // for each new one.
  await subsClient.userFills({ user: "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D" }, (data) => {
    for (const fill of data.fills) {
      if (fill.coin === spotPairId) {
        console.log(fill);
        // e.g. USDT-USDC sell limit order fill (sell USDT for USDC)
        // {
        //   coin: '@166',
        //   px: '0.99987',
        //   sz: '12.0',
        //   side: 'A',
        //   time: 1762442654786,
        //   startPosition: '20.75879498',
        //   dir: 'Sell',
        //   closedPnl: '-0.00266345',
        //   hash: '0x12bac8ba533cb3641434042ef5f8990207c6009fee3fd236b683740d12308d4e',
        //   oid: 225184674691,
        //   crossed: false,
        //   fee: '0.00095987',
        //   tid: 854069469806140,
        //   feeToken: 'USDC',
        //   twapId: null
        // }
      }
    }
  });
}

if (require.main === module) {
  run()
    .then(async () => {
      process.exitCode = 0;
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      process.exitCode = 128;
    });
}

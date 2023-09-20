import { clients } from "@across-protocol/sdk-v2";
import { FundsDepositedEvent } from "../interfaces";
import { isDefined } from "../utils/TypeGuards";

export class SpokePoolClient extends clients.SpokePoolClient {
    _isEarlyDeposit(depositEvent: FundsDepositedEvent, currentTime: number,): boolean {
        const hubCurrentTime = this.hubPoolClient?.currentTime;
        if (!isDefined(hubCurrentTime)) {
          throw new Error("HubPoolClient's currentTime is not defined");
        }
        return (depositEvent.args.quoteTimestamp > currentTime || depositEvent.args.quoteTimestamp > hubCurrentTime)
    }
  
}

import { assert } from "./";

const ZERO_X_API_BASE_URL = "https://api.0x.org";
const ZERO_X_API_VERSION = "v2";

// 0x AllowanceHolder contract address (canonical across all supported chains).
export const ZERO_X_ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734";

// 0x free tier rate limit: 5 RPS in fixed 1-second windows.
const ZERO_X_MAX_RPS = Number(process.env.ZERO_X_MAX_RPS ?? 5);

interface ZeroXTransactionData {
  to: string;
  data: string;
  gas: string;
  value: string;
}
interface ZeroXIssues {
  allowance: unknown | null;
  balance: unknown | null;
}

interface ZeroXPriceResponse {
  buyAmount: string;
  issues: ZeroXIssues;
}

interface ZeroXQuoteResponse extends ZeroXPriceResponse {
  transaction: ZeroXTransactionData;
  minBuyAmount: string;
}

/**
 * Simple rate limiter for 0x API calls. Uses a fixed 1-second window matching
 * the 0x rate limit calculation: up to ZERO_X_MAX_RPS calls per 1-second window.
 */
class ZeroXRateLimiter {
  private windowStart = 0;
  private requestsInWindow = 0;
  private queue: Array<{ resolve: () => void }> = [];
  private draining = false;

  async waitForSlot(): Promise<void> {
    const now = Date.now();

    // Reset window if we've moved past the current 1-second window.
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.requestsInWindow = 0;
    }

    // If we have capacity in the current window, proceed immediately.
    if (this.requestsInWindow < ZERO_X_MAX_RPS) {
      this.requestsInWindow++;
      return;
    }

    // Otherwise, queue this request and wait until the next window.
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
      this._scheduleDrain();
    });
  }

  private _scheduleDrain(): void {
    if (this.draining) {
      return;
    }
    this.draining = true;

    const msUntilNextWindow = 1000 - (Date.now() - this.windowStart);
    setTimeout(
      () => {
        this.draining = false;
        this.windowStart = Date.now();
        this.requestsInWindow = 0;

        // Release up to ZERO_X_MAX_RPS queued requests.
        const toRelease = Math.min(this.queue.length, ZERO_X_MAX_RPS);
        for (let i = 0; i < toRelease; i++) {
          this.requestsInWindow++;
          this.queue.shift().resolve();
        }

        // If there are still queued requests, schedule another drain.
        if (this.queue.length > 0) {
          this._scheduleDrain();
        }
      },
      Math.max(msUntilNextWindow, 0)
    );
  }
}

const rateLimiter = new ZeroXRateLimiter();

function getHeaders(): Record<string, string> {
  const apiKey = process.env.ZERO_X_API_KEY;
  assert(apiKey, "ZERO_X_API_KEY environment variable is required for Matcha/0x API calls");
  return {
    "0x-api-key": apiKey,
    "0x-version": ZERO_X_API_VERSION,
  };
}

/**
 * Get a firm quote from the 0x Swap API. This commits liquidity and returns an executable transaction.
 * Use this when ready to execute a swap.
 */
export async function getMatchaQuote(
  chainId: number,
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  takerAddress: string,
  slippageBps?: number
): Promise<ZeroXQuoteResponse> {
  await rateLimiter.waitForSlot();

  const params = new URLSearchParams({
    chainId: chainId.toString(),
    sellToken,
    buyToken,
    sellAmount,
    taker: takerAddress,
  });
  if (slippageBps !== undefined) {
    // 0x API expects slippage as a decimal (e.g., 0.01 for 1%)
    params.set("slippagePercentage", (slippageBps / 10000).toString());
  }

  const url = `${ZERO_X_API_BASE_URL}/swap/allowance-holder/quote?${params.toString()}`;
  const response = await fetch(url, { headers: getHeaders() });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`0x quote API error (${response.status}): ${errorBody}`);
  }
  return (await response.json()) as ZeroXQuoteResponse;
}

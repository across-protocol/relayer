
#!/bin/bash
echo "Running relayer on Goerli. Will fill any deposits for origin chain [1/5] to destination chain [5/1]"
echo "HubPool should have set SpokePools for chains 1 and 5 to same Goerli SpokePool."
if [ "$NODE_URLS_5" != "$NODE_URLS_1" ]; then
  echo "NODE_URLS_5 and NODE_URLS_1 are not the same. Exiting."
  exit 1
fi

export RELAYER_IGNORE_LIMITS="true"
export RELAYER_TOKENS='["0x40153DdFAd90C49dbE3F5c9F96f2a5B25ec67461"]'
export MAX_RELAYER_DEPOSIT_LOOK_BACK=172800
export NODE_DISABLE_PROVIDER_CACHING=true
export IGNORE_PROFITABILITY=true
export MAX_BLOCK_LOOK_BACK='{ "1": 20000, "10": 10000, "137": 3499, "288": 4990, "42161": 10000, "5": 10000 }'
export HUB_CHAIN_ID=5
export SPOKE_POOL_CHAINS_OVERRIDE="[5, 1]"
export CHAIN_ID_LIST_OVERRIDE="[5,1]"


ts-node ./index.ts --relayer --wallet mnemonic
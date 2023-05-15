
#!/bin/bash
echo "Running relayer on Goerli. Will fill any deposits for origin chain [5/421613] to destination chain [421613/5]"

# Use a nonstandard Redis port to avoid data base corruption on any existing Redis instance
export REDIS_URL=redis://localhost:3636

export RELAYER_IGNORE_LIMITS="true"
export RELAYER_TOKENS='["0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6"]'
export MAX_RELAYER_DEPOSIT_LOOK_BACK=14400
export NODE_DISABLE_PROVIDER_CACHING=true
export RELAYER_GAS_MULTIPLIER=.01
export MIN_RELAYER_FEE_PCT=.00001
export MAX_BLOCK_LOOK_BACK='{ "1": 20000, "10": 10000, "137": 3499, "288": 4990, "42161": 10000, "5": 10000, "421613": 10000 }'
export HUB_CHAIN_ID=5
export SPOKE_POOL_CHAINS_OVERRIDE="[5, 421613]"
export CHAIN_ID_LIST_OVERRIDE="[5,421613]"


ts-node ./index.ts --relayer --wallet mnemonic
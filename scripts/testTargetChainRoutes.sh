#!/bin/bash

##############################################
############ SCRIPT DEFINITIONS ##############
##############################################

# This script is used to test the target chain routes for a given chain ID.
# It does this by first making an HTTP request to the /api/available-routes endpoint
# as both the origin and destination chain. It then iterates over the response and
# calls the yarn deposit command for each route.
#
# In doing so, this script will test the following:
#   - The target chain ID is valid
#   - The target chain ID is available as both an origin and destination chain
#   - The target chain ID has at least one route available
#   - A deposit can be made to the target chain ID

##############################################
############# SCRIPT ARGUMENTS ###############
##############################################

# This script accepts two arguments:
#   - The first argument is the target chain ID
#   - The second argument is the base domain to make the HTTP request to
#   - The third argument is the amount of tokens to transmit, in USD
#
# Example usage: ./testTargetChainRoutes.sh my-chain-id example.com 10

##############################################
########### CUSTOM FUNCTIONS #################
##############################################

# This function accepts two arguments:
#   - The first argument is the JSON object
#   - The second argument is the field to extract from the JSON object
#
# Example usage: get_json_field '{"originChainId": "my-chain-id"}' "originChainId"
get_json_field() {
    json_obj=$1
    field=$2
    echo $(python3 -c "import sys, json; print(json.loads('$json_obj')['$field'])")
}

# This function accepts one argument:
#   - The first argument is a stringified JSON string. This string should be a JSON array.
#
# This function returns the length of the JSON array.
get_json_array_length() {
    json_array=$1
    echo $(python3 -c "import sys, json; print(len(json.loads('$json_array')))")
}

# This function accepts two arguments:
#   - The first argument is a stringified JSON string. This string should be a JSON array.
#   - The second argument is the index of the JSON array to extract
#
# This function returns the JSON object at the specified index of the JSON array.
get_json_array_element() {
    json_array=$1
    index=$2
    echo $(python3 -c "import sys, json; print(json.dumps(json.loads('$json_array')[$index]))")
}

# This function accepts one argument:
#   - The first argument is the JSON object
#
# This function returns whether or not the JSON Object is valid. It uses Python to return a boolean
# by utilizing try and except blocks.
is_json_object_valid() {
    json_obj=$1
    echo $(python3 -c "import sys, json; print(json.loads('$json_obj'))")
}

##############################################
########### MAIN SCRIPT ######################
##############################################

TARGET_CHAIN_ID=$1
BASE_DOMAIN=$2
AMOUNT_TO_TRANSMIT=$3

# Verify that the target chain ID and the base domain were provided
if [ -z "$TARGET_CHAIN_ID" ] || [ -z "$BASE_DOMAIN" ] || [ -z "$AMOUNT_TO_TRANSMIT" ]; then
    echo "Usage: $0 <target chain ID> <base domain> <amount to transmit>"
    exit 1
fi

# Make the HTTP request to retrieve the list of available routes with originChainId={target chain}
ORIGIN_ROUTES=$(curl -s "https://${BASE_DOMAIN}/api/available-routes?originChainId=${TARGET_CHAIN_ID}")

# Make the HTTP request to retrieve the list of available routes with destinationChainId={target chain}
DESTINATION_ROUTES=$(curl -s "https://${BASE_DOMAIN}/api/available-routes?destinationChainId=${TARGET_CHAIN_ID}")

# Make the HTTP request to retrieve a list of tokens that are available
TOKEN_LIST=$(curl -s "https://${BASE_DOMAIN}/api/token-list")

# Resolve the number of tokens in the token list
TOKEN_LIST_LENGTH=$(get_json_array_length "$TOKEN_LIST")

# Iterate over the length of the TOKEN_LIST array. We must
# iterate until one less than the length of the array because
# the array is zero-indexed.
for ((i = 0; i < TOKEN_LIST_LENGTH; i++)); do

    # Extract the JSON object at the current index
    json_obj=$(get_json_array_element "$TOKEN_LIST" $i)

    # Extract the token address
    token_address=$(get_json_field "$json_obj" "address")

    # Extract the token Symbol
    token_symbol=$(get_json_field "$json_obj" "symbol")

    #Extract the L1 token address
    l1_token_address=$(get_json_field "$json_obj" "l1TokenAddress")

    # Extract the number of decimals
    token_decimals=$(get_json_field "$json_obj" "decimals")

    # Check if the variable L1_TOKEN_PRICE_LOOKUP, postfixed with the L1 token address, is empty\
    # I.e. check if L1_TOKEN_PRICE_LOOKUP__0x0000000000000000 is empty
    cache_key="L1_TOKEN_PRICE_LOOKUP__$l1_token_address"

    if [ -z "${!cache_key}" ]; then
        # Make the HTTP request to retrieve the L1 token price
        token_price=$(curl -s "https://${BASE_DOMAIN}/api/coingecko?l1Token=${l1_token_address}")

        # The result of which is a JSON object. Extract the "price" field from the JSON object.
        token_price=$(get_json_field "$token_price" "price")

        # Print out the token price and exit
        echo "Token price for $token_address is $token_price"

        # One token is equal to 10^decimals of the token. We need to convert the amount to transmit
        # (which is stored in USD) to the number of tokens to transmit. We do this by dividing the
        # amount to transmit by the token price, and then multiplying by 10^decimals.
        tokens_to_transmit=$(echo "$AMOUNT_TO_TRANSMIT * 10^$token_decimals / $token_price" | bc)

        # Indicate the number of tokens to transmit
        echo "Will need to transmit $tokens_to_transmit units of $token_symbol ($token_address)"

        # Store the L1 token amount to transmit in the cache dictionary
        declare "$cache_key=$tokens_to_transmit"

    else
        # Retrieve the L1 token price from the cache dictionary
        tokens_to_transmit=${!cache_key}
    fi

    # Store the resulting token price in the TOKEN_LIST_DICT dictionary
    true_token_dict_key="TOKEN_LIST_DICT__$token_address"
    declare "$true_token_dict_key=$tokens_to_transmit"

done

# Iterate over both arrays
for route in "${ORIGIN_ROUTES[@]}" "${DESTINATION_ROUTES[@]}"; do

    # Extract the JSON objects from the response using sed
    json_objs=$(echo "$route" | sed -e 's/.*\[\(.*\)\].*/\1/' -e 's/},{/}\n{/g')

    # Iterate over the JSON objects
    for json_obj in $json_objs; do
        # Extract the from chain ID
        from_chain_id=$(get_json_field "$json_obj" "originChainId")

        # Extract the to chain ID
        to_chain_id=$(get_json_field "$json_obj" "destinationChainId")

        # Extract the origin token address
        origin_token_address=$(get_json_field "$json_obj" "originToken")

        # We now need to retrieve the amount of tokens to transmit for the origin token address.
        # We do this by checking the TOKEN_LIST_DICT dictionary, postfixed with the origin token address.
        tokens_to_transmit_key="TOKEN_LIST_DICT__$origin_token_address"

        # Check if the variable tokens_to_transmit_key is empty. If it is, we can print an error message
        # and skip this route.
        if [ -z "${!tokens_to_transmit_key}" ]; then
            echo "No token price found for $origin_token_address"
            continue
        fi

        # If we reach this point, we know that the tokens_to_transmit_key variable is not empty. We can
        # resolve it
        tokens_to_transmit=${!cache_key}

        # Print out the deposit message
        echo "Sending a deposit from $from_chain_id to $to_chain_id on token $origin_token_address"

        # Call yarn deposit with the correct arguments
        echo $(yarn deposit --from $from_chain_id --to $to_chain_id --token $origin_token_address --amount $tokens_to_transmit)

    done

done

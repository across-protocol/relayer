#!/bin/bash

##############################################
############ SCRIPT Definitions ##############
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
#   - The third argument is the amount of tokens to transmit
#
# Example usage: ./testTargetChainRoutes.sh my-chain-id example.com

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

        # Print out the deposit message
        echo "Sending a deposit from $from_chain_id to $to_chain_id on token $origin_token_address"

        # Call yarn deposit with the correct arguments
        echo $(yarn deposit --from $from_chain_id --to $to_chain_id --token $origin_token_address --amount $AMOUNT_TO_TRANSMIT)

    done

done

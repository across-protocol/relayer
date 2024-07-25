#!/bin/bash

set -o errexit
set -o nounset

if [ -z "$GH_TOKEN" ]; then
    FILE="fill-times.json"
    FILE_PATH="src/data/fill-times.json"
    curl -s -o ${FILE_PATH} "https://${GH_TOKEN}@${GH_REPO_URL}/${FILE}"
    echo "Updated data at ${FILE_PATH}"
else
     echo '{"empty": "empty"}' > ${FILE_PATH}
     echo "Using default data at ${FILE_PATH}"
fi

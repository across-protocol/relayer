FROM node:22.18

ARG INVENTORY_CONFIG_FILES

WORKDIR /across-relayer
COPY . ./

RUN apt-get update
RUN apt-get install -y libudev-dev libusb-1.0-0-dev jq yarn rsync
RUN yarn

# Validate inventory config files if specified
RUN if [ -n "$INVENTORY_CONFIG_FILES" ]; then \
      yarn ts-node scripts/fetchInventoryConfig.ts $INVENTORY_CONFIG_FILES; \
    else \
      echo "No inventory config files specified, skipping validation"; \
    fi

RUN yarn build

ENTRYPOINT ["/bin/bash", "scripts/runCommand.sh"]
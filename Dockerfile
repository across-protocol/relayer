FROM node:22.18

ARG CONFIGURAMA_BASE_URL
ARG CONFIGURAMA_ENV
ARG CONFIGURAMA_FILE_PATH
ARG RELAYER_EXTERNAL_INVENTORY_CONFIG

# GitHub config for fetching inventory config during postinstall
ARG GITHUB_TOKEN
ARG GITHUB_REPO_OWNER
ARG GITHUB_REPO_NAME
ARG GITHUB_FILE_PATHS
ARG GITHUB_FOLDER_NAME
ARG GITHUB_BRANCH

# We need to have these environment variables set for run-time as well
ENV CONFIGURAMA_BASE_URL=${CONFIGURAMA_BASE_URL}
ENV CONFIGURAMA_ENV=${CONFIGURAMA_ENV}
ENV CONFIGURAMA_FILE_PATH=${CONFIGURAMA_FILE_PATH}
ENV RELAYER_EXTERNAL_INVENTORY_CONFIG=${RELAYER_EXTERNAL_INVENTORY_CONFIG}

# Set GitHub env vars for postinstall script (update-inventory-config)
ENV GITHUB_TOKEN=${GITHUB_TOKEN}
ENV GITHUB_REPO_OWNER=${GITHUB_REPO_OWNER}
ENV GITHUB_REPO_NAME=${GITHUB_REPO_NAME}
ENV GITHUB_FILE_PATHS=${GITHUB_FILE_PATHS}
ENV GITHUB_FOLDER_NAME=${GITHUB_FOLDER_NAME}
ENV GITHUB_BRANCH=${GITHUB_BRANCH}

WORKDIR /across-relayer

COPY . ./

RUN apt-get update
RUN apt-get install -y libudev-dev libusb-1.0-0-dev jq yarn rsync
RUN yarn
RUN echo "Verifying inventory config was downloaded:" && ls -la *.json || true

# Clear sensitive token after install
ENV GITHUB_TOKEN=""

RUN yarn build

ENTRYPOINT ["/bin/bash", "scripts/runCommand.sh"]
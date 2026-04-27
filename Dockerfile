FROM node:22.18-bookworm-slim

ARG CONFIGURAMA_FOLDER_PATH
ARG CONFIGURAMA_FOLDER_ENVIRONMENT
ARG CONFIGURAMA_FOLDER_BASE_URL

ENV CONFIGURAMA_FOLDER_PATH=$CONFIGURAMA_FOLDER_PATH
ENV CONFIGURAMA_FOLDER_ENVIRONMENT=$CONFIGURAMA_FOLDER_ENVIRONMENT
ENV CONFIGURAMA_FOLDER_BASE_URL=$CONFIGURAMA_FOLDER_BASE_URL

WORKDIR /across-relayer

COPY . ./

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && yarn install --frozen-lockfile \
 && yarn build \
 && yarn install --production --frozen-lockfile \
 && yarn cache clean \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/bin/sh", "scripts/runCommand.sh"]

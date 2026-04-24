FROM node:22.18-alpine3.22

ARG CONFIGURAMA_FOLDER_PATH
ARG CONFIGURAMA_FOLDER_ENVIRONMENT
ARG CONFIGURAMA_FOLDER_BASE_URL

ENV CONFIGURAMA_FOLDER_PATH=$CONFIGURAMA_FOLDER_PATH
ENV CONFIGURAMA_FOLDER_ENVIRONMENT=$CONFIGURAMA_FOLDER_ENVIRONMENT
ENV CONFIGURAMA_FOLDER_BASE_URL=$CONFIGURAMA_FOLDER_BASE_URL

WORKDIR /across-relayer

COPY . ./

RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && yarn install --frozen-lockfile \
 && yarn build \
 && yarn install --production --frozen-lockfile \
 && yarn cache clean \
 && apk del .build-deps

ENTRYPOINT ["/bin/sh", "scripts/runCommand.sh"]

FROM node:20

WORKDIR /across-relayer

COPY . ./

RUN apt-get update
RUN apt-get install -y libudev-dev libusb-1.0-0-dev jq yarn rsync ca-certificates
RUN yarn

RUN yarn build

ENTRYPOINT ["/bin/bash", "scripts/runCommand.sh"]

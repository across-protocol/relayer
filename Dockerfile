FROM node:20

WORKDIR /relayer

COPY . ./

RUN apt-get update
RUN apt-get install -y libudev-dev libusb-1.0-0-dev jq yarn rsync
RUN yarn

RUN yarn build

ENTRYPOINT ["/bin/bash", "scripts/runCommand.sh"]

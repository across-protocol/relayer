import { object, min, string, integer } from "superstruct";

export const BlockUpdateMessage = object({
  blockNumber: min(integer(), 0),
  currentTime: min(integer(), 0),
});

export const EventsAddedMessage = object({
  nEvents: min(integer(), 0),
  data: string(),
});

export const EventRemovedMessage = object({
  event: string(),
});

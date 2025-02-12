import { object, min, string, integer } from "superstruct";

export const EventsAddedMessage = object({
  blockNumber: min(integer(), 0),
  currentTime: min(integer(), 0),
  nEvents: min(integer(), 0),
  data: string(),
});

export const EventRemovedMessage = object({
  event: string(),
});

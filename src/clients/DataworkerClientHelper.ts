import { ConfigStoreClient } from ".";
import { Clients } from "./ClientHelper";

export interface DataworkerClients extends Clients {
  configStoreClient: ConfigStoreClient;
}

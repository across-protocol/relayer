import { CommonConfig } from "../common";

export class DataworkerConfig extends CommonConfig {
    // TODO: Consider allowing caller to override the token transfer via environment variable. Could be used to emergency
    // rebalance funds or handle when config store is set incorrectly.
    // Similarly, consider allowing caller to override any config store variable via env var.
}

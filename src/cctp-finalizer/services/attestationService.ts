import axios from "axios";
import { CCTPAttestationResponse } from "../types";

export class AttestationService {
  private readonly baseUrl: string;

  constructor(isMainnet: boolean = true) {
    this.baseUrl = isMainnet ? "https://iris-api.circle.com" : "https://iris-api-sandbox.circle.com";
  }

  async fetchAttestation(sourceDomainId: number, transactionHash: string): Promise<CCTPAttestationResponse> {
    try {
      const response = await axios.get<CCTPAttestationResponse>(
        `${this.baseUrl}/v2/messages/${sourceDomainId}?transactionHash=${transactionHash}`
      );
      return response.data;
    } catch (error) {
      console.error("Failed to fetch attestation:", error);
      throw new Error(`Failed to fetch attestation for transaction ${transactionHash}`);
    }
  }

  isAttestationReady(status: string): boolean {
    return ["complete", "done", "succeeded"].includes(status);
  }
}

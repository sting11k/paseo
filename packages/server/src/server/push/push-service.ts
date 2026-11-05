import type pino from "pino";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH_SIZE = 100;

/**
 * Service for sending Expo push notifications.
 * Handles batching and invalid token removal.
 */
export class PushService {
  private readonly logger: pino.Logger;
  private readonly revokeToken: (token: string) => void;

  constructor(logger: pino.Logger, revokeToken: (token: string) => void) {
    this.logger = logger.child({ component: "push-service" });
    this.revokeToken = revokeToken;
  }

  /** Resolves once Expo accepted the push for at least one device; rejects with why it accepted none. */
  async sendPush(tokens: string[], payload: PushPayload): Promise<void> {
    if (tokens.length === 0) {
      throw new Error("No registered push device");
    }

    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: "default",
    }));

    // Batch tokens (max 100 per request per Expo limits)
    const batches: ExpoPushMessage[][] = [];
    for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
      batches.push(messages.slice(i, i + MAX_BATCH_SIZE));
    }

    const results = await Promise.all(batches.map((batch) => this.sendBatch(batch)));
    if (results.some((result) => result.accepted > 0)) {
      return;
    }
    throw new Error(
      results.find((result) => result.error)?.error ?? "Push service accepted no device",
    );
  }

  private async sendBatch(
    messages: ExpoPushMessage[],
  ): Promise<{ accepted: number; error?: string }> {
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status, statusText: response.statusText },
          "Expo push API error",
        );
        return { accepted: 0, error: `Expo push API error ${response.status}` };
      }

      const result = (await response.json()) as { data: ExpoPushTicket[] };
      return this.handleTickets(messages, result.data);
    } catch (error) {
      this.logger.error({ err: error }, "Failed to send push notifications");
      return { accepted: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private handleTickets(
    messages: ExpoPushMessage[],
    tickets: ExpoPushTicket[],
  ): { accepted: number; error?: string } {
    let accepted = 0;
    let error: string | undefined;
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const message = messages[i];

      if (ticket.status === "ok") {
        accepted++;
      } else if (ticket.status === "error") {
        error = ticket.details?.error ?? ticket.message ?? "Push failed for device";
        this.logger.error(
          { token: message.to, message: ticket.message, details: ticket.details },
          "Push failed for token",
        );

        // Remove invalid tokens
        if (
          ticket.details?.error === "DeviceNotRegistered" ||
          ticket.details?.error === "InvalidCredentials"
        ) {
          this.revokeToken(message.to);
        }
      }
    }
    return { accepted, ...(error ? { error } : {}) };
  }
}

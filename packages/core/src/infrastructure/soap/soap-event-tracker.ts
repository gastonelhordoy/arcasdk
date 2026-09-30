import { Client } from "soap";
import type {
  ArcaEvent,
  ArcaEventListener,
  ArcaEventService,
} from "@application/types/events.types";

interface PendingCall {
  service: ArcaEventService;
  method: string;
  endpoint?: string;
}

// token and sign elements, plain (SOAP headers and bodies) or entity-escaped
// (the login ticket WSAA returns inside loginCmsReturn)
const CREDENTIAL_ELEMENTS = [
  /(<(?:[\w.-]+:)?(token|sign)\b[^>]*>)[\s\S]*?(<\/(?:[\w.-]+:)?\2\s*>)/gi,
  /(&lt;(?:[\w.-]+:)?(token|sign)\b(?:(?!&gt;)[\s\S])*&gt;)[\s\S]*?(&lt;\/(?:[\w.-]+:)?\2\s*&gt;)/gi,
];

let exchangeSequence = 0;

/** Replaces the content of every WSAA token and sign element with `[REDACTED]` */
export function redactCredentials(xml: string): string {
  return CREDENTIAL_ELEMENTS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "$1[REDACTED]$3"),
    xml,
  );
}

function nextExchangeId(): string {
  exchangeSequence = (exchangeSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${exchangeSequence.toString(36)}`;
}

function responseBodyOf(error: unknown): string | undefined {
  const candidate = error as {
    body?: unknown;
    response?: { data?: unknown };
  } | null;
  const body = candidate?.body ?? candidate?.response?.data;
  return typeof body === "string" ? body : undefined;
}

/**
 * Emits `soap:request`, `soap:response` and `soap:error` for the calls made
 * through one SOAP client. node-soap builds the envelope, so the request event
 * comes from its `request` event; the exchange id passed to node-soap ties it
 * to the call, which stays correct when calls on the client overlap.
 */
export class SoapEventTracker {
  private readonly pending = new Map<string, PendingCall>();

  constructor(
    private readonly client: Client,
    private readonly onEvent: ArcaEventListener,
  ) {
    client.on("request", (xml: string, exchangeId: string) => {
      const call = this.pending.get(exchangeId);
      if (!call) return;
      // node-soap sets lastEndpoint right before emitting, in the same tick
      call.endpoint = this.client.lastEndpoint;
      this.emit({
        type: "soap:request",
        ...call,
        exchangeId,
        xml: redactCredentials(xml),
      });
    });
  }

  /**
   * Runs one SOAP call and emits its events. `invoke` must pass the options it
   * receives to the node-soap method, so the request carries the exchange id.
   */
  async track<T>(
    service: ArcaEventService,
    method: string,
    invoke: (options: { exchangeId: string }) => Promise<T>,
  ): Promise<T> {
    const exchangeId = nextExchangeId();
    const call: PendingCall = { service, method };
    this.pending.set(exchangeId, call);
    const startedAt = Date.now();

    try {
      const result = await invoke({ exchangeId });
      const rawResponse = Array.isArray(result) ? result[1] : undefined;
      this.emit({
        type: "soap:response",
        ...call,
        exchangeId,
        xml:
          typeof rawResponse === "string" ? redactCredentials(rawResponse) : "",
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      const body = responseBodyOf(error);
      this.emit({
        type: "soap:error",
        ...call,
        exchangeId,
        error,
        xml: body === undefined ? undefined : redactCredentials(body),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      this.pending.delete(exchangeId);
    }
  }

  private emit(event: ArcaEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // a listener must never break a call to ARCA
    }
  }
}

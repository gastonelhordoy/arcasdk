import { ArcaServiceName } from "./service-name.types";

/** Service a SOAP call went to: an ARCA business service, or WSAA while logging in */
export type ArcaEventService = ArcaServiceName | "wsaa";

interface ArcaSoapEventBase {
  /** Service the call went to */
  service: ArcaEventService;
  /** SOAP operation, e.g. `FECAESolicitar` or `loginCms` */
  method: string;
  /** URL the request was sent to */
  endpoint?: string;
  /** Identifies one call: the request event and its response or error event share it */
  exchangeId: string;
}

/** Emitted right before the request goes out */
export interface ArcaSoapRequestEvent extends ArcaSoapEventBase {
  type: "soap:request";
  /** SOAP envelope sent, with the WSAA token and sign redacted */
  xml: string;
}

/** Emitted when ARCA answered and the SDK parsed the answer */
export interface ArcaSoapResponseEvent extends ArcaSoapEventBase {
  type: "soap:response";
  /** SOAP envelope received, with the WSAA token and sign redacted */
  xml: string;
  durationMs: number;
}

/** Emitted when the call failed: network error, HTTP error or SOAP fault */
export interface ArcaSoapErrorEvent extends ArcaSoapEventBase {
  type: "soap:error";
  error: unknown;
  /** Body ARCA answered with, when there was one, with the WSAA token and sign redacted */
  xml?: string;
  durationMs: number;
}

export type ArcaEvent =
  ArcaSoapRequestEvent | ArcaSoapResponseEvent | ArcaSoapErrorEvent;

/**
 * Receives every SDK event. It is called synchronously; whatever it throws is
 * ignored, so a failing listener never breaks a call to ARCA.
 */
export type ArcaEventListener = (event: ArcaEvent) => void;

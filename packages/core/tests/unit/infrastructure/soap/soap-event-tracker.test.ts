import { EventEmitter } from "events";
import { Client } from "soap";
import type { ArcaEvent } from "@application/types/events.types";
import {
  SoapEventTracker,
  redactCredentials,
} from "@infrastructure/soap/soap-event-tracker";

const ENDPOINT = "https://wswhomo.afip.gov.ar/wsfev1/service.asmx";

function createClient(): Client & EventEmitter {
  const client = new EventEmitter() as Client & EventEmitter;
  client.lastEndpoint = ENDPOINT;
  return client;
}

// what node-soap does on a call: emit the envelope with the exchange id, then answer
function sendRequest(
  client: EventEmitter,
  exchangeId: string,
  xml = "<soap:Envelope>request</soap:Envelope>",
) {
  client.emit("request", xml, exchangeId);
}

describe("redactCredentials", () => {
  it("should redact Token and Sign elements, with or without prefix", () => {
    const xml =
      "<ar:Auth><ar:Token>PD94bWwg</ar:Token><ar:Sign>c2lnbg==</ar:Sign>" +
      "<ar:Cuit>20111111112</ar:Cuit></ar:Auth>";

    expect(redactCredentials(xml)).toBe(
      "<ar:Auth><ar:Token>[REDACTED]</ar:Token><ar:Sign>[REDACTED]</ar:Sign>" +
        "<ar:Cuit>20111111112</ar:Cuit></ar:Auth>",
    );
  });

  it("should redact lowercase token and sign (padrón services)", () => {
    expect(
      redactCredentials("<token>abc</token><sign>def</sign><cuit>1</cuit>"),
    ).toBe("<token>[REDACTED]</token><sign>[REDACTED]</sign><cuit>1</cuit>");
  });

  it("should redact the entity-escaped ticket returned by loginCms", () => {
    const xml =
      "<loginCmsReturn>&lt;credentials&gt;&lt;token&gt;PD94&lt;/token&gt;" +
      "&lt;sign&gt;c2ln&lt;/sign&gt;&lt;/credentials&gt;</loginCmsReturn>";

    expect(redactCredentials(xml)).toBe(
      "<loginCmsReturn>&lt;credentials&gt;&lt;token&gt;[REDACTED]&lt;/token&gt;" +
        "&lt;sign&gt;[REDACTED]&lt;/sign&gt;&lt;/credentials&gt;</loginCmsReturn>",
    );
  });

  it("should leave elements that only start with token or sign untouched", () => {
    const xml = "<tokenType>A</tokenType><signature>B</signature>";
    expect(redactCredentials(xml)).toBe(xml);
  });
});

describe("SoapEventTracker", () => {
  let client: Client & EventEmitter;
  let events: ArcaEvent[];
  let tracker: SoapEventTracker;

  beforeEach(() => {
    client = createClient();
    events = [];
    tracker = new SoapEventTracker(client, (event) => events.push(event));
  });

  it("should emit request and response events sharing the exchange id", async () => {
    const result = await tracker.track("wsfe", "FECAESolicitar", async (o) => {
      sendRequest(client, o.exchangeId);
      return [{ ok: true }, "<soap:Envelope>response</soap:Envelope>", {}, ""];
    });

    expect(result[0]).toEqual({ ok: true });
    expect(events).toHaveLength(2);
    const [request, response] = events;
    expect(request).toMatchObject({
      type: "soap:request",
      service: "wsfe",
      method: "FECAESolicitar",
      endpoint: ENDPOINT,
      xml: "<soap:Envelope>request</soap:Envelope>",
    });
    expect(response).toMatchObject({
      type: "soap:response",
      service: "wsfe",
      method: "FECAESolicitar",
      endpoint: ENDPOINT,
      exchangeId: request.exchangeId,
      xml: "<soap:Envelope>response</soap:Envelope>",
    });
    expect(response).toEqual(
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
  });

  it("should redact credentials in request and response", async () => {
    await tracker.track("wsfe", "FECompUltimoAutorizado", async (o) => {
      sendRequest(client, o.exchangeId, "<Token>secret</Token>");
      return [{}, "<Sign>secret</Sign>", {}, ""];
    });

    expect(events.map((e) => e.xml)).toEqual([
      "<Token>[REDACTED]</Token>",
      "<Sign>[REDACTED]</Sign>",
    ]);
  });

  it("should emit an error event with the response body and rethrow", async () => {
    const fault = Object.assign(new Error("soap:Server: boom"), {
      body: "<soap:Fault><Token>secret</Token></soap:Fault>",
    });

    await expect(
      tracker.track("ws_sr_padron_a5", "getPersona_v2", async (o) => {
        sendRequest(client, o.exchangeId);
        throw fault;
      }),
    ).rejects.toBe(fault);

    expect(events.map((e) => e.type)).toEqual(["soap:request", "soap:error"]);
    expect(events[1]).toMatchObject({
      type: "soap:error",
      service: "ws_sr_padron_a5",
      method: "getPersona_v2",
      error: fault,
      xml: "<soap:Fault><Token>[REDACTED]</Token></soap:Fault>",
    });
  });

  it("should take the body of an HTTP error from response.data", async () => {
    const httpError = Object.assign(new Error("Request failed"), {
      response: { data: "<html>502</html>" },
    });

    await expect(
      tracker.track("wsfe", "FEDummy", async () => {
        throw httpError;
      }),
    ).rejects.toBe(httpError);

    expect(events).toEqual([
      expect.objectContaining({ type: "soap:error", xml: "<html>502</html>" }),
    ]);
  });

  it("should emit an error event without xml for a network error", async () => {
    await expect(
      tracker.track("wsfe", "FEDummy", async () => {
        throw new Error("ECONNRESET");
      }),
    ).rejects.toThrow("ECONNRESET");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "soap:error", xml: undefined });
  });

  it("should keep overlapping calls apart", async () => {
    let releaseFirst!: () => void;
    const first = tracker.track("wsfe", "FECAESolicitar", async (o) => {
      sendRequest(client, o.exchangeId, "<first/>");
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      return [{}, "<first-response/>", {}, ""];
    });
    const second = tracker.track("wsfe", "FECompConsultar", async (o) => {
      sendRequest(client, o.exchangeId, "<second/>");
      return [{}, "<second-response/>", {}, ""];
    });
    await second;
    releaseFirst();
    await first;

    const byMethod = (method: string) =>
      events.filter((e) => e.method === method).map((e) => e.xml);
    expect(byMethod("FECAESolicitar")).toEqual([
      "<first/>",
      "<first-response/>",
    ]);
    expect(byMethod("FECompConsultar")).toEqual([
      "<second/>",
      "<second-response/>",
    ]);
    const ids = new Set(events.map((e) => e.exchangeId));
    expect(ids.size).toBe(2);
  });

  it("should ignore requests from calls it is not tracking", () => {
    sendRequest(client, "someone-else");
    expect(events).toHaveLength(0);
  });

  it("should not let a throwing listener break the call", async () => {
    const failing = new SoapEventTracker(client, () => {
      throw new Error("listener failed");
    });

    await expect(
      failing.track("wsfe", "FECAESolicitar", async (o) => {
        sendRequest(client, o.exchangeId);
        return [{ cae: "123" }, "<r/>", {}, ""];
      }),
    ).resolves.toEqual([{ cae: "123" }, "<r/>", {}, ""]);
  });

  it("should keep the original error when a listener throws on it", async () => {
    const failing = new SoapEventTracker(client, () => {
      throw new Error("listener failed");
    });

    await expect(
      failing.track("wsfe", "FEDummy", async () => {
        throw new Error("ARCA down");
      }),
    ).rejects.toThrow("ARCA down");
  });
});

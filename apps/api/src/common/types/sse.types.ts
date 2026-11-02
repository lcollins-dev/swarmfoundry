export interface IHeartbeatOptions {
  /** Ends the response once the payloads complete. Otherwise the beat holds it open until the client leaves. */
  endWithPayloads?: boolean;
  /**
   * The id the client resumes after. Given, a message without an id, beats included, repeats the last id sent, since
   * Nest would number it and so move the client's resume point.
   */
  lastEventId?: string;
}

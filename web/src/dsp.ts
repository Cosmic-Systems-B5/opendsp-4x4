// High-level DSP client over any DspTransport. Builds confirmed command frames,
// sends them, and parses replies ([01,00,N,code,data]). Encodings still being
// calibrated (PEQ gain dB, crossover Hz) are exposed in raw form via control.ts.
//
// When bound to a bridge transport (WebSocketTransport), `guid` selects which
// DSP unit the request is meant for. The transport uses it to filter replies
// so multiple units on one socket don't collide. For USB transports
// (WebHidTransport) `guid` is undefined and ignored.
import type { DspTransport } from "./transport/transport.ts";
import { parseReply, type Reply } from "./protocol/frame.ts";
import {
  muteFrame, levelRawFrame, levelDbFrame, polarityFrame,
  recallPresetFrame, storePresetFrame, getVersionFrame, getStatusFrame,
  readPresetNameFrame, readChannelFrame, finalizeFrame,
  testToneFrame, setPasswordFrame,
} from "./protocol/control.ts";
import {
  peqBandFrame, crossoverHpfFrame, crossoverLpfFrame, delayMsFrame,
  compressorFrame, gateFrame, routingFrame,
} from "./protocol/blocks.ts";

const ascii = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0+$/, "").trim();

export class Dsp {
  private readonly guid?: string;

  constructor(
      private readonly transport: DspTransport,
      guid?: string,
  ) {
    this.guid = guid;
  }

  /**
   * Wake/handshake: send the status query the device expects first after connect.
   * (0x13/version and other reads only reply once this has been sent.)
   */
  async wake(): Promise<Reply> { return this.send(getStatusFrame()); }

  /** Read the device version string (e.g. "4x4MINIPRO V010"). */
  async getVersion(): Promise<string> {
    await this.wake();
    return ascii((await this.send(getVersionFrame())).data);
  }

  /** Read a preset's name by slot (0..29). */
  async presetName(slot: number): Promise<string> {
    const r = await this.send(readPresetNameFrame(slot));
    return ascii(r.data.slice(1));
  }

  /** Read a channel's raw 50-byte state block (0..8). */
  async channelState(index: number): Promise<Uint8Array> {
    return (await this.send(readChannelFrame(index))).data;
  }

  mute(chan: number, on: boolean): Promise<Reply> { return this.send(muteFrame(chan, on)); }
  setPolarity(chan: number, invert: boolean): Promise<Reply> { return this.send(polarityFrame(chan, invert)); }
  setLevelRaw(chan: number, raw16: number): Promise<Reply> { return this.send(levelRawFrame(chan, raw16)); }
  setLevelDb(chan: number, db: number): Promise<Reply> { return this.send(levelDbFrame(chan, db)); }
  recallPreset(slot: number): Promise<Reply> { return this.send(recallPresetFrame(slot)); }
  storePreset(slot: number): Promise<Reply> { return this.send(storePresetFrame(slot)); }
  finalize(): Promise<Reply> { return this.send(finalizeFrame()); }

  // --- DSP blocks (params are protocol-native; UI applies dB/Hz calibration first) ---
  peqBand(chan: number, band: number, o: { freqHz: number; q: number; gainRaw: number; type: number; bypass?: boolean }): Promise<Reply> {
    return this.send(peqBandFrame(chan, band, o));
  }
  crossoverHpf(chan: number, freqRaw: number, slope: number): Promise<Reply> { return this.send(crossoverHpfFrame(chan, freqRaw, slope)); }
  crossoverLpf(chan: number, freqRaw: number, slope: number): Promise<Reply> { return this.send(crossoverLpfFrame(chan, freqRaw, slope)); }
  delayMs(chan: number, ms: number): Promise<Reply> { return this.send(delayMsFrame(chan, ms)); }
  compressor(chan: number, o: { ratioIndex: number; kneeDb: number; attackMs: number; releaseMs: number; thresholdDb: number }): Promise<Reply> {
    return this.send(compressorFrame(chan, o));
  }
  gate(chan: number, o: { attackMs: number; releaseMs: number; holdMs: number; thresholdDb: number }): Promise<Reply> { return this.send(gateFrame(chan, o)); }
  routing(outChan: number, inputMask: number): Promise<Reply> { return this.send(routingFrame(outChan, inputMask)); }
  testTone(source: number, freqIndex = 0): Promise<Reply> { return this.send(testToneFrame(source, freqIndex)); }
  setPassword(pw: string): Promise<Reply> { return this.send(setPasswordFrame(pw)); }

  /**
   * Send a pre-built request frame and parse the reply.
   * `guid` (bridge only) selects which unit the request targets, so replies
   * for other units on the same socket are ignored by the transport.
   */
  async send(frame: Uint8Array): Promise<Reply> {
    return parseReply(await this.transport.request(frame, undefined, this.guid));
  }
}
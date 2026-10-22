Open-source, cross-platform control software for the **the t.racks DSP 4x4 Mini Pro**
(a 4-in/4-out XLR DSP that ships with Windows-only editor software).

In two parts. the server/bridge.js that runs on remote hardware connected via USB to the DSP unit and runs a websocket server bridge between the HID and the remote Web UI. The bridge can also mock DSP units for testing and display a web page with live updates of current state of each unit, both mock and real.

- Clean, strongly-typed, well-separated codebase; everything driven by one documented
  protocol.
- Write the code like a senior experienced software developer.
- Please regularly commit progress with appropriate commit message to git.

- Do a proper planning stage and write tests first, TDD style.
- Solve each non passing test one by without overloading the context.

- Some tasks will require editing both the /web and the server/ parts.
- Do not remove comments unless they're part of a method that's being removed
- Originally based on https://github.com/GlassOnTin/opendsp-4x4/tree/main/web/src so if confused check there for help

The device is a USB-HID device (`0168:0821`) using 64-byte interrupt reports. The control
protocol was developed **clean-room**, by observing the device's USB-HID traffic and probing
it directly (write a known value, read it back, match the bytes); see [`PROTOCOL.md`](PROTOCOL.md).
The protocol is the single source of truth and is implemented per-platform:

- **`web/`** — TypeScript + **WebHID** desktop app (Chrome/Edge). Zero-install. Routing,
  gain/mute/polarity, 7-band PEQ, crossovers, compressor, gate, delay, presets, live meters
  and full device-state readback are implemented and **live-verified on the hardware**.
  Known gaps: PEQ Q scaling is provisional and gate timing isn't yet calibrated to ms.

## Repo layout
- [`PROTOCOL.md`](PROTOCOL.md) — the wire protocol (frame format, command codes, data model).

- [`server/`](server/) — Javascript HID / Websocket Bridge

- [`web/`](web/) — TypeScript protocol codec + Websocket

## Legal
Independent, **clean-room** interoperability implementation: the control protocol was
developed solely by observing the device's USB-HID interface. "the t.racks" is a trademark
of Thomann; this project is not affiliated with or endorsed by Thomann.

Licensed under **GNU AGPL-3.0-or-later** (see `LICENSE`) — strong copyleft: any
distributed or network-served derivative must publish its source under the same terms.

    Original Copyright (C) 2026 Ian Williams https://github.com/GlassOnTin/opendsp-4x4

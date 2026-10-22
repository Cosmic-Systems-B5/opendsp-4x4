// Preset manager for JSON save/load system.
//
// Presets are device-agnostic by default: they contain channels, routing,
// eqLink, and a preset name. Two optional fields, `serverid` and `guid`,
// record which DSP the preset was saved from. They're never used for lookup
// (the preset id is the key) but they let a caller decide "load into the
// device it came from" vs "load into any connected device".

import type { Channel } from "./device-model.ts";

const PRESET_VERSION = "1.0";
const DEFAULT_PRESET_NAME = "Untitled preset";

interface DspPreset {
  id: string;                // Unique GUID for the preset (per-preset identity)
  version: string;
  name: string;
  timestamp: string;
  /** Optional: which device this preset was saved from. */
  serverid?: string;
  guid?: string;
  device: {
    channels: Channel[];
    routing: number[];
    eqLink: Record<number, number>;
  };
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function downloadJsonFile(data: object, filename: string): void {
  try {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error("Error downloading file:", e);
    throw new Error(`Failed to download: ${(e as Error).message}`);
  }
}

/** Deep-clone one Channel. Aliased eq/comp/gate would otherwise leak across
 *  a saved preset and a live edit. */
function cloneChannel(ch: Channel): Channel {
  return {
    index: ch.index,
    name: ch.name,
    isOutput: ch.isOutput,
    gainDb: ch.gainDb,
    mute: ch.mute,
    polarity: ch.polarity,
    meter: ch.meter,
    eq: ch.eq ? {
      bands: ch.eq.bands.map(b => ({ ...b })),
      hpf: { freqHz: ch.eq.hpf.freqHz, slope: ch.eq.hpf.slope },
      lpf: { freqHz: ch.eq.lpf.freqHz, slope: ch.eq.lpf.slope },
    } : undefined,
    delayMs: ch.delayMs,
    comp: ch.comp ? { ...ch.comp } : undefined,
    gate: ch.gate ? { ...ch.gate } : undefined,
    eqMode: ch.eqMode,
  };
}

class PresetManager {
  private presets: DspPreset[] = [];
  private listeners: (() => void)[] = [];

  constructor() {
    this.loadPresets();
  }

  subscribe(callback: () => void): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (e) { console.warn('preset subscriber failed:', e); }
    }
  }

  // --- save ------------------------------------------------------------

  /** Save the current device state to a new preset. */
  saveDeviceStateToPreset(
      name: string,
      channels: Channel[],
      routing: number[],
      eqLink: Record<number, number>,
      identity?: { serverid?: string; guid?: string },
  ): DspPreset {
    const newPreset: DspPreset = {
      id: generateId(),
      version: PRESET_VERSION,
      name: name || DEFAULT_PRESET_NAME,
      timestamp: new Date().toISOString(),
      serverid: identity?.serverid,
      guid: identity?.guid,
      device: {
        channels: channels.map(cloneChannel),
        routing: [...routing],
        eqLink: { ...eqLink },
      },
    };

    this.presets = [newPreset, ...this.presets];
    this.savePresets();
    this.notify();
    return newPreset;
  }

  // --- load / read -----------------------------------------------------

  loadPreset(index: number): DspPreset | undefined {
    if (index < 0 || index >= this.presets.length) return undefined;
    return this.presets[index];
  }

  getPresets(): DspPreset[] {
    return [...this.presets];
  }

  findPresetIndexById(id: string): number {
    if (!id) return -1;
    return this.presets.findIndex(p => p.id === id);
  }

  /** Export a preset by id as JSON. Does NOT create one if missing. */
  exportPreset(id: string): string | null {
    const idx = this.findPresetIndexById(id);
    if (idx < 0) return null;
    return JSON.stringify(this.presets[idx], null, 2);
  }

  /** Export the most recently-saved preset as JSON. */
  exportCurrentPreset(): string | null {
    return this.presets[0] ? JSON.stringify(this.presets[0], null, 2) : null;
  }

  exportAllPresets(): string {
    return JSON.stringify(this.presets, null, 2);
  }

  // --- update ----------------------------------------------------------

  /** Replace an existing preset by id. Returns false if not found. */
  updatePresetById(id: string, updates: Partial<DspPreset>): boolean {
    const idx = this.findPresetIndexById(id);
    if (idx < 0) return false;
    const current = this.presets[idx]!;

    const nextDevice = {
      channels: updates.device?.channels
          ? updates.device.channels.map(cloneChannel)
          : current.device.channels.map(cloneChannel),
      routing: updates.device?.routing
          ? [...updates.device.routing]
          : [...current.device.routing],
      eqLink: updates.device?.eqLink
          ? { ...updates.device.eqLink }
          : { ...current.device.eqLink },
    };

    this.presets[idx] = {
      id: current.id,
      version: current.version,
      name: updates.name ?? current.name,
      timestamp: updates.timestamp ?? current.timestamp,
      serverid: updates.serverid ?? current.serverid,
      guid: updates.guid ?? current.guid,
      device: nextDevice,
    };
    this.savePresets();
    this.notify();
    return true;
  }

  // --- delete ----------------------------------------------------------

  deletePreset(index: number): void {
    if (index < 0 || index >= this.presets.length) return;
    this.presets = this.presets.filter((_, i) => i !== index);
    this.savePresets();
    this.notify();
  }

  clearAllPresets(): void {
    this.presets = [];
    this.savePresets();
    this.notify();
  }

  // --- import / export -------------------------------------------------

  /** Import a single preset. Accepts a JSON string or an already-parsed object. */
  importPreset(presetData: DspPreset | string): void {
    let preset: DspPreset;
    if (typeof presetData === 'string') {
      try { preset = JSON.parse(presetData); }
      catch { throw new Error("Invalid JSON format"); }
    } else {
      preset = presetData;
    }

    // Accept both the current shape (device.channels / device.routing) and
    // the legacy shape (top-level channels / routing).
    const p = preset as any;
    const device = p.device ?? { channels: p.channels, routing: p.routing };
    if (!Array.isArray(device?.channels) || !Array.isArray(device?.routing)) {
      throw new Error("Invalid preset structure");
    }

    // Normalise into the current shape.
    const normalised: DspPreset = {
      id: preset.id || generateId(),
      version: preset.version || PRESET_VERSION,
      name: preset.name || DEFAULT_PRESET_NAME,
      timestamp: preset.timestamp || new Date().toISOString(),
      serverid: preset.serverid,
      guid: preset.guid,
      device: {
        channels: device.channels.map(cloneChannel),
        routing: [...device.routing],
        eqLink: device.eqLink ?? {},
      },
    };

    const existingIndex = this.findPresetIndexById(normalised.id);
    if (existingIndex >= 0) this.presets[existingIndex] = normalised;
    else this.presets = [normalised, ...this.presets];

    this.savePresets();
    this.notify();
  }

  /** Import many presets. Accepts either shape (current or legacy). */
  importMultiplePresets(jsonString: string): void {
    try {
      const imported = JSON.parse(jsonString);
      if (!Array.isArray(imported)) {
        throw new Error("Invalid preset format - expected array");
      }

      const valid = imported.filter((p: any) => {
        const device = p?.device ?? p;
        return p &&
            typeof p.name === 'string' &&
            Array.isArray(device?.channels) &&
            Array.isArray(device?.routing);
      });

      if (valid.length === 0) throw new Error("No valid presets found in file");

      const normalised: DspPreset[] = valid.map((p: any) => {
        const device = p.device ?? p;
        return {
          id: p.id || generateId(),
          version: p.version || PRESET_VERSION,
          name: p.name || DEFAULT_PRESET_NAME,
          timestamp: p.timestamp || new Date().toISOString(),
          serverid: p.serverid,
          guid: p.guid,
          device: {
            channels: device.channels.map(cloneChannel),
            routing: [...device.routing],
            eqLink: device.eqLink ?? {},
          },
        };
      });

      this.presets = [...normalised, ...this.presets];
      this.savePresets();
      this.notify();
    } catch (e) {
      console.error("Error importing presets:", e);
      throw new Error(`Failed to import presets: ${(e as Error).message}`);
    }
  }

  // --- download --------------------------------------------------------

  downloadPreset(index: number): DspPreset | undefined {
    const preset = this.loadPreset(index);
    if (!preset) return undefined;
    const { timestamp, ...exportable } = preset;
    const filename = `${preset.name.replace(/[^a-z0-9]/gi, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
    downloadJsonFile(exportable, filename);
    return preset;
  }

  downloadAllPresets(): void {
    const cleaned = this.getPresets().map(({ timestamp, ...preset }) => preset);
    downloadJsonFile(cleaned, `dsp-presets-${new Date().toISOString().slice(0, 10)}.json`);
  }

  // --- persistence -----------------------------------------------------

  private savePresets(): void {
    try {
      // Cap at 50 presets to keep the localStorage write bounded.
      const toSave = this.presets.slice(0, 50);
      localStorage.setItem("opendsp-presets", JSON.stringify(toSave));
    } catch (e) {
      console.error("Error saving presets:", e);
    }
  }

  private loadPresets(): void {
    try {
      const data = localStorage.getItem("opendsp-presets");
      if (!data) return;
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return;
      this.presets = parsed.map((p: any) => {
        // Backward-compat: pre-device presets had top-level channels/routing.
        const device = p.device ?? { channels: p.channels, routing: p.routing };
        return {
          id: p.id || generateId(),
          version: p.version || PRESET_VERSION,
          name: p.name || DEFAULT_PRESET_NAME,
          timestamp: p.timestamp || new Date().toISOString(),
          serverid: p.serverid,
          guid: p.guid,
          device: {
            channels: Array.isArray(device?.channels) ? device.channels.map(cloneChannel) : [],
            routing: Array.isArray(device?.routing) ? [...device.routing] : [0x01, 0x02, 0x04, 0x08],
            eqLink: device?.eqLink ?? {},
          },
        };
      });
    } catch (e) {
      console.error("Error loading presets:", e);
    }
  }

  // --- name generator --------------------------------------------------

  advancedNameGenerator(): string {
    const adjectives = [
      'Red', 'Blue', 'Green', 'Golden', 'Silver', 'Purple', 'Crimson', 'Azure',
      'Emerald', 'Amber', 'Violet', 'Indigo', 'Ebony', 'Ivory', 'Scarlet',
      'Magenta', 'Turquoise', 'Cerulean', 'Vermilion', 'Saffron', 'Cobalt',
      'Lavender', 'Mauve', 'Teal', 'Maroon', 'Charcoal', 'Pearl', 'Bronze',
      'Platinum', 'Ruby', 'Sapphire', 'Topaz', 'Jade', 'Onyx', 'Coral',
      'Happy', 'Sad', 'Angry', 'Calm', 'Wild', 'Gentle', 'Fierce', 'Serene',
      'Mystic', 'Lonely', 'Brave', 'Silent', 'Proud', 'Joyful', 'Peaceful',
      'Eager', 'Weary', 'Furious', 'Anxious', 'Hopeful', 'Desolate', 'Ecstatic',
      'Melancholy', 'Vibrant', 'Tranquil', 'Wrathful', 'Blissful', 'Somber',
      'Jubilant', 'Pensive', 'Ferocious', 'Timid', 'Confident', 'Desperate',
      'Flowing', 'Raging', 'Still', 'Ancient', 'Eternal', 'Verdant', 'Barren',
      'Frozen', 'Blazing', 'Thundering', 'Whispering', 'Howling', 'Rushing',
      'Crumbling', 'Blooming', 'Withering', 'Shimmering', 'Glistening', 'Radiant',
      'Shadowy', 'Luminous', 'Twilight', 'Dawn', 'Dusk', 'Solar', 'Lunar',
      'Smooth', 'Rough', 'Polished', 'Weathered', 'Crystalline', 'Metallic',
      'Earthen', 'Mossy', 'Sandy', 'Stony', 'Wooden', 'Icy', 'Fiery', 'Fuzzy',
      'Prickly', 'Sleek', 'Glossy', 'Matte', 'Velvet', 'Silken', 'Leathery',
      'Bouncy', 'Wobbly', 'Giggling', 'Sleepy', 'Dizzy', 'Silly', 'Goofy',
      'Clumsy', 'Bumbling', 'Wiggly', 'Squishy', 'Fluffy', 'Fuzzy', 'Sparkly',
      'Twirly', 'Whirly', 'Dancing', 'Singing', 'Chuckling', 'Giddy',
    ];

    const nouns = [
      'Dragon', 'Wolf', 'Eagle', 'Lion', 'Tiger', 'Fox', 'Bear', 'Hawk',
      'Falcon', 'Raven', 'Panther', 'Leopard', 'Owl', 'Shark', 'Rhino',
      'Buffalo', 'Cobra', 'Phoenix', 'Griffin', 'Unicorn', 'Basilisk',
      'Platypus', 'Capybara', 'Sloth', 'Quokka', 'Axolotl', 'Fennec', 'Pangolin',
      'Manatee', 'Narwhal', 'Blobfish', 'Tarsier', 'Aye-Aye', 'Sugar Glider',
      'Hedgehog', 'Puffin', 'Penguin', 'Otter', 'Ferret', 'Meerkat', 'Lemur',
      'Koala', 'Wombat', 'Tamarin', 'Marmoset', 'Chinchilla', 'Guinea Pig',
      'Hamster', 'Gerbil', 'Bunny', 'Puppy', 'Kitten', 'Piglet', 'Calf',
      'Fawn', 'Duckling', 'Gosling', 'Tadpole', 'Caterpillar', 'Ladybug',
      'Mermaid', 'Faerie', 'Sprite', 'Pixie', 'Gnome', 'Brownie', 'Leprechaun',
      'Will-o-Wisp', 'Jackalope', 'Wolpertinger', 'Cheshire', 'Snorkack',
      'Niffler', 'Porg', 'Ewok', 'Wookie', 'Gremlin', 'Mogwai', 'Fraggle',
      'Meatball', 'Noodle', 'Pancake', 'Waffle', 'Cupcake', 'Muffin', 'Donut',
      'Pickle', 'Potato', 'Bean', 'Sprout', 'Peapod', 'Marshmallow', 'Jellybean',
      'Gummy Bear', 'Lollipop', 'Brownie', 'Cookie', 'Pudding',
    ];

    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adj} ${noun}`;
  }
}

const presetManager = new PresetManager();
export default presetManager;
export type { DspPreset };
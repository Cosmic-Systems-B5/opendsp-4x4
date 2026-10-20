// Preset manager for JSON save/load system

import type {Channel} from "./model.ts";

const PRESET_VERSION = "1.0";
const DEFAULT_PRESET_NAME = "Untitled preset";

// Full DSP preset data structure - device settings in nested object, metadata at root
interface DspPreset {
  id: string;       // Unique GUID for the preset
  version: string;
  name: string;
  timestamp: string;
  device: {
    channels: Channel[];
    routing: number[];
    activePreset: number;
    eqLink: Record<number, number>;
    presetName: string;
  };
}

// Generate a simple unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Export download functionality as a utility function
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

class PresetManager {
  // Use regular arrays with manual reactivity tracking
  private presets: DspPreset[] = [];
  private listeners: (() => void)[] = [];

  constructor() {
    // Load presets from localStorage on init
    this.loadPresets();
  }

  /** Get/set preset name for current session */
  get presetName(): string {
    return this._presetName;
  }
  set presetName(name: string) {
    this._presetName = name;
  }
  private _presetName = "";

  /** Subscribe to preset changes */
  subscribe(callback: () => void): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Notify listeners of a change */
  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Save the current device state to a new preset */
  saveCurrentPreset(name?: string, channels?: Channel[], routing?: number[]): DspPreset {
    const newPreset: DspPreset = {
      id: generateId(),
      version: PRESET_VERSION,
      name: name || DEFAULT_PRESET_NAME,
      timestamp: new Date().toISOString(),
      device: {
        channels: channels || [],
        routing: routing || [0x01, 0x02, 0x04, 0x08],
        activePreset: -1,
        eqLink: {},
        presetName: ""
      }
    };

    this.presets = [newPreset, ...this.presets];
    this.savePresets();
    this.notify();
    return newPreset;
  }

  /** Save current device state with all data to a preset */
  saveDeviceStateToPreset(name: string, channels: Channel[], routing: number[], eqLink: Record<number, number>, activePreset: number = -1): DspPreset {
    const newPreset: DspPreset = {
      id: generateId(),
      version: PRESET_VERSION,
      name,
      timestamp: new Date().toISOString(),
      device: {
        // Clone channels to prevent external modifications
        channels: channels.map(ch => ({ ...ch })),
        routing: [...routing],
        activePreset,
        eqLink: { ...eqLink },
        presetName: this.presetName || ""
      }
    };

    this.presets = [newPreset, ...this.presets];
    this.savePresets();
    this.notify();
    return newPreset;
  }

  /** Export current preset as JSON string */
  exportCurrentPreset(): string {
    // Return empty until a preset is actually saved with real data
    const preset = this.presets.length > 0 ? this.presets[0] : this.saveCurrentPreset();
    return JSON.stringify(preset, null, 2);
  }

  /** Import a preset from JSON */
  importPreset(presetData: DspPreset | string): void {
    let preset: DspPreset;

    if (typeof presetData === 'string') {
      try {
        preset = JSON.parse(presetData);
      } catch (e) {
        throw new Error("Invalid JSON format");
      }
    } else {
      preset = presetData;
    }

    // Validate preset - check for device object structure
    const device = preset.device || {};
    if (!device.channels || !Array.isArray(device.routing)) {
      throw new Error("Invalid preset structure");
    }

    // Update or add preset by ID (more reliable than timestamp)
    const existingIndex = this.presets.findIndex(p => p.id === preset.id);
    if (existingIndex >= 0) {
      this.presets[existingIndex] = preset;
    } else {
      this.presets = [preset, ...this.presets];
    }

    this.savePresets();
    this.notify();
  }

  /** Load a preset by index */
  loadPreset(index: number): DspPreset | undefined {
    if (index < 0 || index >= this.presets.length) return undefined;
    return this.presets[index];
  }

  /** Delete a preset by index */
  deletePreset(index: number): void {
    if (index < 0 || index >= this.presets.length) return;

    this.presets = this.presets.filter((_, i) => i !== index);
    this.savePresets();
    this.notify();
  }

  /** Update an existing preset by ID */
  updatePresetById(id: string, updates: Partial<DspPreset>): boolean {
    const idx = this.presets.findIndex(p => p.id === id);
    if (idx < 0) return false;

    // Get the current preset data to merge with
    const currentPreset = this.presets[idx];
    if (!currentPreset) return false;

    // Merge updates - handle device settings separately
    const updatedDevice = {
      ...currentPreset.device,
      channels: updates.device?.channels ?? currentPreset.device.channels.map(ch => ({
        ...ch,
        eq: ch.eq || undefined,  // Preserve existing EQ or leave undefined
        delayMs: ch.delayMs,
        comp: ch.comp || (this.isOutput(ch.index) ? { thresholdDb: 20, ratioIndex: 0, kneeDb: 0, attackMs: 50, releaseMs: 500 } : undefined),
        gate: ch.gate || (!this.isOutput(ch.index) ? { thresholdDb: -90, attackMs: 50, holdMs: 100, releaseMs: 500 } : undefined)
      })),
      routing: updates.device?.routing ?? currentPreset.device.routing,
      activePreset: updates.device?.activePreset ?? currentPreset.device.activePreset,
      eqLink: updates.device?.eqLink ?? currentPreset.device.eqLink,
      presetName: updates.device?.presetName ?? currentPreset.device.presetName
    };

    this.presets[idx] = {
      id: currentPreset.id,
      version: currentPreset.version,
      name: updates.name ?? currentPreset.name,
      timestamp: updates.timestamp ?? currentPreset.timestamp,
      device: updatedDevice
    };
    this.savePresets();
    this.notify();
    return true;
  }

  // Helper to determine if channel is output (index >= 4 means it's an output)
  private isOutput(index: number): boolean {
    return index >= 4; // OUT_BASE = 0x04 = 4
  }

  /** Find the index of a preset by ID */
  findPresetIndexById(id: string): number {
    if (!id) return -1;
    return this.presets.findIndex(p => p.id === id);
  }

  /** Get all saved presets */
  getPresets(): DspPreset[] {
    return [...this.presets];
  }

  /** Export presets to a JSON string (all presets) */
  exportAllPresets(): string {
    return JSON.stringify(this.presets, null, 2);
  }

  /** Import multiple presets from a JSON string */
  importMultiplePresets(jsonString: string): void {
    try {
      const imported = JSON.parse(jsonString);

      if (!Array.isArray(imported)) {
        throw new Error("Invalid preset format - expected array");
      }

      // Validate and filter valid presets
      const validPresets = imported.filter(p => {
        return p &&
          typeof p.name === 'string' &&
          Array.isArray(p.channels) &&
          Array.isArray(p.routing);
      });

      if (validPresets.length === 0) {
        throw new Error("No valid presets found in file");
      }

      this.presets = [...validPresets, ...this.presets];
      this.savePresets();
      this.notify();
    } catch (e) {
      console.error("Error importing presets:", e);
      throw new Error(`Failed to import presets: ${(e as Error).message}`);
    }
  }

  /** Save presets to localStorage */
  private savePresets(): void {
    try {
      // Only save the last 50 presets to avoid localStorage quota issues
      const toSave = this.presets.slice(0, 50);
      localStorage.setItem("opendsp-presets", JSON.stringify(toSave));
    } catch (e) {
      console.error("Error saving presets:", e);
    }
  }

  /** Load presets from localStorage */
  private loadPresets(): void {
    try {
      const data = localStorage.getItem("opendsp-presets");
      if (data) {
        this.presets = JSON.parse(data);
        // Ensure all presets have the correct structure with all fields
        this.presets.forEach(preset => {
          // Generate ID for presets that don't have one (backward compatibility)
          if (!preset.id) {
            preset.id = generateId();
          }

          // Handle both new and old preset structures
          const device = preset.device || {};

          if (!device.channels || device.channels.length === 0) {
            device.channels = [];
          }
          if (!device.routing || device.routing.length === 0) {
            device.routing = [0x01, 0x02, 0x04, 0x08];
          }
          // Initialize missing fields with defaults
          if (device.eqLink === undefined) device.eqLink = {};
          if (device.presetName === undefined) device.presetName = "";
        });
      }
    } catch (e) {
      console.error("Error loading presets:", e);
    }
  }

  /** Clear all saved presets */
  clearAllPresets(): void {
    this.presets = [];
    localStorage.removeItem("opendsp-presets");
    this.notify();
  }

  /**
   * Download a specific preset by index as JSON file
   * @param index - Index of the preset to download
   * @returns The downloaded preset data
   */
  downloadPreset(index: number): DspPreset | undefined {
    const preset = this.loadPreset(index);
    if (!preset) return undefined;

    // Create a copy without timestamp for cleaner export (user can add their own)
    const { timestamp, ...exportable } = preset;
    const filename = `${preset.name.replace(/[^a-z0-9]/gi, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
    downloadJsonFile(exportable, filename);

    return preset;
  }

  /**
   * Download all presets as a single JSON file
   */
  downloadAllPresets(): void {
    // Create clean export without internal timestamps
    const cleanedPresets = this.getPresets().map(({ timestamp, ...preset }) => preset);
    downloadJsonFile(cleanedPresets, `dsp-presets-${new Date().toISOString().slice(0, 10)}.json`);
  }

  advancedNameGenerator(): string {
    let adjectives = [
      // Colors (Expanded)
      'Red', 'Blue', 'Green', 'Golden', 'Silver', 'Purple', 'Crimson', 'Azure',
      'Emerald', 'Amber', 'Violet', 'Indigo', 'Ebony', 'Ivory', 'Scarlet',
      'Magenta', 'Turquoise', 'Cerulean', 'Vermilion', 'Saffron', 'Cobalt',
      'Lavender', 'Mauve', 'Teal', 'Maroon', 'Charcoal', 'Pearl', 'Bronze',
      'Platinum', 'Ruby', 'Sapphire', 'Topaz', 'Jade', 'Onyx', 'Coral',
      // Moods/Emotions (Expanded)
      'Happy', 'Sad', 'Angry', 'Calm', 'Wild', 'Gentle', 'Fierce', 'Serene',
      'Mystic', 'Lonely', 'Brave', 'Silent', 'Proud', 'Joyful', 'Peaceful',
      'Eager', 'Weary', 'Furious', 'Anxious', 'Hopeful', 'Desolate', 'Ecstatic',
      'Melancholy', 'Vibrant', 'Tranquil', 'Wrathful', 'Blissful', 'Somber',
      'Jubilant', 'Pensive', 'Ferocious', 'Timid', 'Confident', 'Desperate',
      // Nature Elements
      'Flowing', 'Raging', 'Still', 'Ancient', 'Eternal', 'Verdant', 'Barren',
      'Frozen', 'Blazing', 'Thundering', 'Whispering', 'Howling', 'Rushing',
      'Crumbling', 'Blooming', 'Withering', 'Shimmering', 'Glistening', 'Radiant',
      'Shadowy', 'Luminous', 'Twilight', 'Dawn', 'Dusk', 'Solar', 'Lunar',
      // Textures & Materials
      'Smooth', 'Rough', 'Polished', 'Weathered', 'Crystalline', 'Metallic',
      'Earthen', 'Mossy', 'Sandy', 'Stony', 'Wooden', 'Icy', 'Fiery', 'Fuzzy',
      'Prickly', 'Sleek', 'Glossy', 'Matte', 'Velvet', 'Silken', 'Leathery',
      // Silly & Whimsical
      'Bouncy', 'Wobbly', 'Giggling', 'Sleepy', 'Dizzy', 'Silly', 'Goofy',
      'Clumsy', 'Bumbling', 'Wiggly', 'Squishy', 'Fluffy', 'Fuzzy', 'Sparkly',
      'Twirly', 'Whirly', 'Dancing', 'Singing', 'Chuckling', 'Giddy'
    ]

    let nouns = [
      // Animals (Expanded with silly/non-fierce)
      'Dragon', 'Wolf', 'Eagle', 'Lion', 'Tiger', 'Fox', 'Bear', 'Hawk',
      'Falcon', 'Raven', 'Panther', 'Leopard', 'Owl', 'Shark', 'Rhino',
      'Buffalo', 'Cobra', 'Phoenix', 'Griffin', 'Unicorn', 'Basilisk',

      // Silly & Gentle Animals
      'Platypus', 'Capybara', 'Sloth', 'Quokka', 'Axolotl', 'Fennec', 'Pangolin',
      'Manatee', 'Narwhal', 'Blobfish', 'Tarsier', 'Aye-Aye', 'Sugar Glider',
      'Hedgehog', 'Puffin', 'Penguin', 'Otter', 'Ferret', 'Meerkat', 'Lemur',
      'Koala', 'Wombat', 'Tamarin', 'Marmoset', 'Chinchilla', 'Guinea Pig',
      'Hamster', 'Gerbil', 'Bunny', 'Puppy', 'Kitten', 'Piglet', 'Calf',
      'Fawn', 'Duckling', 'Gosling', 'Tadpole', 'Caterpillar', 'Ladybug',

      // Mythical & Whimsical Creatures
      'Mermaid', 'Faerie', 'Sprite', 'Pixie', 'Gnome', 'Brownie', 'Leprechaun',
      'Will-o-Wisp', 'Jackalope', 'Wolpertinger', 'Cheshire', 'Snorkack',
      'Niffler', 'Porg', 'Ewok', 'Wookie', 'Gremlin', 'Mogwai', 'Fraggle',

      // Everyday Silly Things
      'Meatball', 'Noodle', 'Pancake', 'Waffle', 'Cupcake', 'Muffin', 'Donut',
      'Pickle', 'Potato', 'Bean', 'Sprout', 'Peapod', 'Marshmallow', 'Jellybean',
      'Gummy Bear', 'Lollipop', 'Cupcake', 'Brownie', 'Cookie', 'Pudding'
    ]

    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adjective} ${noun}`;

  }

}

// Export the singleton instance
const presetManager = new PresetManager();

export default presetManager;

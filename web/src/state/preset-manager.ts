// Preset manager for JSON save/load system

import type { Channel } from "./model.ts";

const PRESET_VERSION = "1.0";
const DEFAULT_PRESET_NAME = "Untitled preset";

interface DspPreset {
  version: string;
  name: string;
  channels: Channel[];
  routing: number[];
  activePreset: number;
  timestamp: string;
}

class PresetManager {
  // Use regular arrays with manual reactivity tracking
  private presets: DspPreset[] = [];
  private listeners: (() => void)[] = [];

  constructor() {
    // Load presets from localStorage on init
    this.loadPresets();
  }

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
  saveCurrentPreset(name?: string): DspPreset {
    const newPreset: DspPreset = {
      version: PRESET_VERSION,
      name: name || DEFAULT_PRESET_NAME,
      channels: [],
      routing: [0x01, 0x02, 0x04, 0x08],
      activePreset: -1,
      timestamp: new Date().toISOString()
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

    // Validate preset
    if (!preset.channels || !Array.isArray(preset.routing)) {
      throw new Error("Invalid preset structure");
    }

    // Update or add preset
    const existingIndex = this.presets.findIndex(p => p.timestamp === preset.timestamp);
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
        // Ensure all presets have the correct structure
        this.presets.forEach(preset => {
          if (!preset.channels || preset.channels.length === 0) {
            preset.channels = [];
          }
          if (!preset.routing || preset.routing.length === 0) {
            preset.routing = [0x01, 0x02, 0x04, 0x08];
          }
        });
      }
    } catch (e) {
      console.error("Error loading presets:", e);
    }
  }

  /** Clear all saved presets */
  clearAllPresets(): void {
    this.presets = [];
    this.savePresets();
    this.notify();
  }
}

// Export the singleton instance
const presetManager = new PresetManager();

export default presetManager;
